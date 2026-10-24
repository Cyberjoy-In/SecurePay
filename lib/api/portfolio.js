const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getClient, getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { createAuditEvent } = require('./_audit-outbox');

const LOAN_TERMS = new Set([12, 24, 36]);
const LOAN_RATE = 12;
const REVIEWER_ROLES = new Set(['reviewer', 'admin']);

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 });
  try { return jwt.verify(token, getRequiredEnv('JWT_SECRET')); }
  catch { throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 }); }
}

function badRequest(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode, expose: true }); }
function moneyCents(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) badRequest(`Invalid ${label}.`);
  return Math.round(number * 100);
}
function reviewerRequired(user) {
  if (!REVIEWER_ROLES.has(String(user.role || '').toLowerCase()) && user.is_reviewer !== true) badRequest('Reviewer authorization is required.', 403);
}
function idempotencyKey(req, body) {
  return String(req.headers['idempotency-key'] || body.idempotency_key || '').trim();
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('loans').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('loan_repayments').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('financial_transactions').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('audit_events').createIndex({ delivery_status: 1, created_at: 1 })
  ]);
}

function calculateLoanTerms(principalCents, termMonths) {
  const monthlyRate = LOAN_RATE / 100 / 12;
  const emi = principalCents * monthlyRate * Math.pow(1 + monthlyRate, termMonths) / (Math.pow(1 + monthlyRate, termMonths) - 1);
  const emiCents = Math.round(emi);
  const totalCents = emiCents * termMonths;
  return { emiCents, totalCents, interestCents: totalCents - principalCents };
}

function loanView(loan, repayments = [], audit = null) {
  return {
    ...loan,
    amount: Number(loan.principal_cents || Math.round(Number(loan.amount || 0) * 100)) / 100,
    principal: Number(loan.principal_cents || Math.round(Number(loan.principal || loan.amount || 0) * 100)) / 100,
    interest_amount: Number(loan.interest_cents || Math.round(Number(loan.interest_amount || 0) * 100)) / 100,
    monthly_emi: Number(loan.monthly_emi_cents || Math.round(Number(loan.monthly_emi || 0) * 100)) / 100,
    total_payable: Number(loan.total_payable_cents || Math.round(Number(loan.total_payable || loan.outstanding || 0) * 100)) / 100,
    outstanding: Number(loan.outstanding_cents || Math.round(Number(loan.outstanding || 0) * 100)) / 100,
    outstanding_principal: Number(loan.outstanding_principal_cents || 0) / 100,
    repayments,
    audit_status: audit?.delivery_status || 'PENDING'
  };
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = authenticate(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }

  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
  try { await ensureIndexes(db); } catch { return res.status(500).json({ error: 'Loan data preparation failed.' }); }

  const session = client.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const user = await db.collection('users').findOne({ _id: payload.user_id }, { session });
      const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { session });
      if (!user || !account) badRequest('Account not found.', 404);
      if (Number(payload.token_version || 0) !== Number(user.token_version || 0)) badRequest('Your session has been revoked.', 401);
      if (user.account_status === 'SUSPENDED' || account.status === 'SUSPENDED') badRequest('This account is suspended. Financial actions are unavailable.', 403);

      if (req.method === 'GET') {
        const loans = await db.collection('loans').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray();
        const loanIds = loans.map(loan => loan._id);
        const repayments = await db.collection('loan_repayments').find({ user_id: user._id, loan_id: { $in: loanIds } }, { session }).sort({ created_at: -1 }).toArray();
        const audits = await db.collection('audit_events').find({ user_id: user._id, loan_id: { $in: loanIds } }, { session }).sort({ created_at: -1 }).toArray();
        const cards = await db.collection('cards').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray();
        const deposits = await db.collection('fixed_deposits').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray();
        return {
          account,
          cards,
          deposits,
          loans: loans.map(loan => loanView(loan, repayments.filter(item => item.loan_id === loan._id), audits.find(item => item.loan_id === loan._id))),
          loan_workflow: ['UNDER_REVIEW', 'APPROVED', 'DISBURSED', 'ACTIVE', 'CLOSED', 'REJECTED']
        };
      }

      const body = req.body || {};
      const requestedAction = String(body.action || '').toUpperCase();
      const aliases = { CARD_APPLICATION: 'APPLY_CARD', DAILY_LIMIT_UPDATE: 'SET_LIMIT', LOAN_APPLICATION: 'APPLY_LOAN', FD_OPENED: 'OPEN_FD', FD_CLOSED: 'CLOSE_FD' };
      const action = aliases[requestedAction] || requestedAction;
      const now = new Date();

      if (action === 'APPLY_LOAN') {
        const key = idempotencyKey(req, body);
        if (!key) badRequest('An idempotency key is required for loan submission.');
        const existing = await db.collection('loans').findOne({ user_id: user._id, idempotency_key: key }, { session });
        if (existing) return { action, loan: loanView(existing), audit_event_id: existing.audit_event_id, idempotent: true };
        const principalCents = moneyCents(body.amount, 'loan amount');
        if (principalCents < 1000000 || principalCents > 50000000) badRequest('Loan amount must be between ₹10,000 and ₹5,00,000.');
        const termMonths = Number(body.term_months);
        if (!LOAN_TERMS.has(termMonths)) badRequest('Loan tenure must be 12, 24 or 36 months.');
        const purpose = String(body.purpose || '').trim();
        const employment = String(body.employment || '').trim();
        const monthlyIncomeCents = moneyCents(body.monthly_income, 'monthly income');
        if (purpose.length < 3 || purpose.length > 100) badRequest('Enter a valid loan purpose.');
        if (employment.length < 2 || employment.length > 80) badRequest('Enter valid employment information.');
        if (body.confirmed !== true) badRequest('You must confirm the application details.');
        const terms = calculateLoanTerms(principalCents, termMonths);
        const loanId = createId('LOAN');
        const auditEventId = createId('AUDIT');
        const loan = { _id: loanId, user_id: user._id, idempotency_key: key, principal_cents: principalCents, amount: principalCents / 100, interest_rate: LOAN_RATE, interest_cents: terms.interestCents, monthly_emi_cents: terms.emiCents, total_payable_cents: terms.totalCents, outstanding_cents: terms.totalCents, outstanding_principal_cents: principalCents, outstanding_interest_cents: terms.interestCents, term_months: termMonths, purpose, employment, monthly_income_cents: monthlyIncomeCents, status: 'UNDER_REVIEW', created_at: now, audit_event_id: auditEventId };
        await db.collection('loans').insertOne(loan, { session });
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'LOAN_APPLICATION_SUBMITTED', loan_id: loanId, user_id: user._id, amount_cents: principalCents, principal_cents: principalCents, interest_rate: LOAN_RATE, emi_cents: terms.emiCents, outstanding_balance_cents: terms.totalCents, tenure_months: termMonths, installment_status: 'UNDER_REVIEW', actor_role: 'CUSTOMER', outcome: 'SUBMITTED', idempotency_key: key });
        return { action, loan: loanView(loan), audit_event_id: auditEventId };
      }

      if (['APPROVE_LOAN', 'REJECT_LOAN', 'DISBURSE_LOAN'].includes(action)) {
        reviewerRequired(user);
        const loan = await db.collection('loans').findOne({ _id: String(body.loan_id || '') }, { session });
        if (!loan) badRequest('Loan application not found.', 404);
        if (action === 'APPROVE_LOAN') {
          if (loan.status !== 'UNDER_REVIEW') badRequest('Only loans under review can be approved.');
          await db.collection('loans').updateOne({ _id: loan._id, status: 'UNDER_REVIEW' }, { $set: { status: 'APPROVED', reviewer_id: user._id, reviewer_role: user.role || 'reviewer', decision_at: now }, $unset: { rejection_reason: '' } }, { session });
          const eventId = createId('AUDIT');
          await createAuditEvent(db, session, { _id: eventId, event_type: 'LOAN_APPROVED', loan_id: loan._id, user_id: loan.user_id, amount_cents: loan.principal_cents, principal_cents: loan.principal_cents, interest_rate: loan.interest_rate, emi_cents: loan.monthly_emi_cents, outstanding_balance_cents: loan.outstanding_cents, tenure_months: loan.term_months, installment_status: 'APPROVED', actor_id: user._id, actor_role: user.role || 'reviewer', outcome: 'APPROVED' });
          return { action, loan_id: loan._id, audit_event_id: eventId };
        }
        if (action === 'REJECT_LOAN') {
          const reason = String(body.rejection_reason || '').trim();
          if (loan.status !== 'UNDER_REVIEW') badRequest('Only loans under review can be rejected.');
          if (reason.length < 3 || reason.length > 500) badRequest('A rejection reason is required.');
          await db.collection('loans').updateOne({ _id: loan._id, status: 'UNDER_REVIEW' }, { $set: { status: 'REJECTED', rejection_reason: reason, reviewer_id: user._id, reviewer_role: user.role || 'reviewer', decision_at: now } }, { session });
          const eventId = createId('AUDIT');
          await createAuditEvent(db, session, { _id: eventId, event_type: 'LOAN_REJECTED', loan_id: loan._id, user_id: loan.user_id, amount_cents: loan.principal_cents, principal_cents: loan.principal_cents, interest_rate: loan.interest_rate, emi_cents: loan.monthly_emi_cents, outstanding_balance_cents: loan.outstanding_cents, tenure_months: loan.term_months, installment_status: 'REJECTED', actor_id: user._id, actor_role: user.role || 'reviewer', outcome: 'REJECTED' });
          return { action, loan_id: loan._id, audit_event_id: eventId };
        }
        if (loan.status !== 'APPROVED') badRequest('Only approved loans can be disbursed.');
        const disbursementKey = idempotencyKey(req, body);
        if (!disbursementKey) badRequest('An idempotency key is required for disbursement.');
        const existingDisbursement = await db.collection('financial_transactions').findOne({ type: 'LOAN_DISBURSEMENT', loan_id: loan._id }, { session });
        if (existingDisbursement) return { action, loan_id: loan._id, reference: existingDisbursement._id, idempotent: true };
        const borrowerAccount = await db.collection('accounts').findOne({ user_id: loan.user_id }, { session });
        if (!borrowerAccount) badRequest('Borrower account not found.', 404);
        await db.collection('accounts').updateOne({ _id: borrowerAccount._id }, { $inc: { balance: loan.principal_cents / 100 } }, { session });
        const transactionId = createId('TXN');
        await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: loan.user_id, account_id: borrowerAccount._id, loan_id: loan._id, idempotency_key: disbursementKey, type: 'LOAN_DISBURSEMENT', amount_cents: loan.principal_cents, status: 'COMPLETED', created_at: now }, { session });
        await db.collection('loans').updateOne({ _id: loan._id, status: 'APPROVED' }, { $set: { status: 'DISBURSED', disbursed_at: now, disbursement_transaction_id: transactionId } }, { session });
        const eventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: eventId, event_type: 'LOAN_DISBURSED', loan_id: loan._id, user_id: loan.user_id, amount_cents: loan.principal_cents, principal_cents: loan.principal_cents, interest_rate: loan.interest_rate, emi_cents: loan.monthly_emi_cents, outstanding_balance_cents: loan.outstanding_cents, tenure_months: loan.term_months, installment_status: 'DISBURSED', transaction_id: transactionId, actor_id: user._id, actor_role: user.role || 'reviewer', outcome: 'COMPLETED' });
        return { action, loan_id: loan._id, reference: transactionId, audit_event_id: eventId, new_balance: Number(borrowerAccount.balance) + loan.principal_cents / 100 };
      }

      if (action === 'LOAN_PAYMENT') {
        const key = idempotencyKey(req, body);
        if (!key) badRequest('An idempotency key is required for loan repayment.');
        const existing = await db.collection('loan_repayments').findOne({ user_id: user._id, idempotency_key: key }, { session });
        if (existing) return { action, amount: existing.amount_cents / 100, reference: existing.transaction_id, idempotent: true, new_balance: Number(account.balance) };
        const loan = await db.collection('loans').findOne({ _id: String(body.loan_id || ''), user_id: user._id, status: { $in: ['DISBURSED', 'ACTIVE'] } }, { session });
        if (!loan) badRequest('Only your disbursed or active loan can receive a repayment.');
        const paymentCents = moneyCents(body.amount, 'repayment amount');
        if (paymentCents > Number(loan.outstanding_cents)) badRequest('Repayment cannot exceed the outstanding balance.');
        const interestCents = Math.min(paymentCents, Number(loan.outstanding_interest_cents || 0));
        const principalCents = paymentCents - interestCents;
        const remainingInterest = Number(loan.outstanding_interest_cents || 0) - interestCents;
        const remainingPrincipal = Number(loan.outstanding_principal_cents || 0) - principalCents;
        const remainingTotal = Number(loan.outstanding_cents) - paymentCents;
        const debit = await db.collection('accounts').updateOne({ _id: account._id, balance: { $gte: paymentCents / 100 } }, { $inc: { balance: -(paymentCents / 100) } }, { session });
        if (debit.modifiedCount !== 1) badRequest('Insufficient account balance.');
        const transactionId = createId('TXN');
        const repaymentId = createId('REPAY');
        await db.collection('loan_repayments').insertOne({ _id: repaymentId, user_id: user._id, loan_id: loan._id, idempotency_key: key, amount_cents: paymentCents, principal_cents: principalCents, interest_cents: interestCents, transaction_id: transactionId, status: 'COMPLETED', created_at: now }, { session });
        await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: user._id, account_id: account._id, loan_id: loan._id, type: 'LOAN_REPAYMENT', idempotency_key: key, amount_cents: paymentCents, status: 'COMPLETED', created_at: now }, { session });
        const closed = remainingTotal === 0;
        await db.collection('loans').updateOne({ _id: loan._id, status: { $in: ['DISBURSED', 'ACTIVE'] }, outstanding_cents: Number(loan.outstanding_cents) }, { $set: { outstanding_cents: remainingTotal, outstanding_principal_cents: remainingPrincipal, outstanding_interest_cents: remainingInterest, status: closed ? 'CLOSED' : 'ACTIVE', next_due_date: closed ? null : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), closed_at: closed ? now : null, updated_at: now } }, { session });
        const eventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: eventId, event_type: closed ? 'LOAN_CLOSED' : 'LOAN_EMI_PAYMENT', loan_id: loan._id, user_id: user._id, amount_cents: paymentCents, payment_amount_cents: paymentCents, principal_cents: loan.principal_cents, interest_rate: loan.interest_rate, emi_cents: loan.monthly_emi_cents, outstanding_balance_cents: remainingTotal, tenure_months: loan.term_months, installment_status: closed ? 'CLOSED' : 'ACTIVE', transaction_id: transactionId, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED' });
        return { action, amount: paymentCents / 100, principal_component: principalCents / 100, interest_component: interestCents / 100, reference: transactionId, audit_event_id: eventId, new_balance: Number(account.balance) - paymentCents / 100, status: closed ? 'CLOSED' : 'ACTIVE' };
      }

      if (action === 'APPLY_CARD' || action === 'SET_LIMIT') badRequest('Card operations are handled by /api/cards.');
      if (action === 'SET_LIMIT') {
        const limit = Number(body.limit);
        if (!Number.isFinite(limit) || limit < 1000 || limit > 1000000) badRequest('Set a limit between ₹1,000 and ₹10,00,000.');
        await db.collection('accounts').updateOne({ _id: account._id }, { $set: { daily_limit: limit } }, { session });
        return { action, limit };
      }
      if (action === 'OPEN_FD') {
        const amount = Number(body.amount);
        const tenure = Number(body.tenure_months) || 12;
        if (!Number.isFinite(amount) || amount < 5000) badRequest('Minimum fixed deposit amount is ₹5,000.');
        if (Number(account.balance) < amount) badRequest('Insufficient account balance.');
        const deposit = { _id: createId('FD'), user_id: user._id, principal: amount, interest_rate: 7.1, tenure_months: tenure, maturity_amount: Math.round(amount * (1 + 0.071 * tenure / 12)), status: 'ACTIVE', created_at: now };
        await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: -amount } }, { session });
        await db.collection('fixed_deposits').insertOne(deposit, { session });
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'FD_OPENING_FUNDED', fd_id: deposit._id, user_id: user._id, principal_cents: Math.round(amount * 100), amount_cents: Math.round(amount * 100), interest_rate: deposit.interest_rate, tenure_months: tenure, maturity_amount_cents: Math.round(deposit.maturity_amount * 100), fd_status: deposit.status, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED' });
        return { action, deposit, audit_event_id: auditEventId, new_balance: Number(account.balance) - amount };
      }
      if (action === 'CLOSE_FD') {
        const deposit = await db.collection('fixed_deposits').findOne({ _id: body.deposit_id, user_id: user._id, status: 'ACTIVE' }, { session });
        if (!deposit) badRequest('Fixed deposit not found or already closed.');
        await db.collection('fixed_deposits').updateOne({ _id: deposit._id }, { $set: { status: 'CLOSED', closed_at: now } }, { session });
        await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: deposit.maturity_amount } }, { session });
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'FD_PREMATURE_CLOSURE_COMPLETED', fd_id: deposit._id, user_id: user._id, principal_cents: Math.round(Number(deposit.principal) * 100), amount_cents: Math.round(Number(deposit.maturity_amount) * 100), interest_rate: Number(deposit.interest_rate || 7.1), tenure_months: Number(deposit.tenure_months), maturity_amount_cents: Math.round(Number(deposit.maturity_amount) * 100), fd_status: 'CLOSED', actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED' });
        return { action, amount: deposit.maturity_amount, audit_event_id: auditEventId, new_balance: Number(account.balance) + Number(deposit.maturity_amount) };
      }
      badRequest('Unsupported financial action.');
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ success: false, error: 'This request was already processed or is being processed.' });
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, error: error.expose || status < 500 ? error.message : 'Loan request could not be completed.' });
  } finally {
    await session.endSession();
  }
};
