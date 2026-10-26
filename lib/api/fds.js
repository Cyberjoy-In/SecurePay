const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getClient, getDatabase } = require('./_db');
const { createId, displayId } = require('./_ids');
const { createAuditEvent } = require('./_audit-outbox');

const SUPPORTED_TENURES = new Set([12, 24, 36]);
const ANNUAL_RATE_BPS = 710; // 7.10% illustrative simple interest
const PREMATURE_RATE_BPS = 510; // 5.10% illustrative early-closure rate
const MINIMUM_PRINCIPAL_CENTS = 500000;

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 });
  try { return jwt.verify(token, getRequiredEnv('JWT_SECRET')); }
  catch { throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 }); }
}

function badRequest(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode, expose: true }); }
function idempotencyKey(req, body) { return String(req.headers['idempotency-key'] || body.idempotency_key || '').trim(); }
function moneyCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) badRequest('Enter a valid FD amount.');
  return Math.round(number * 100);
}
function addMonths(date, months) {
  const source = new Date(date);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1, 0, 0, 0, 0));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
function monthsElapsed(start, end, maxMonths) {
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, Math.min(maxMonths, months));
}
function interestCents(principalCents, rateBps, months) {
  return Math.round(principalCents * rateBps / 10000 * months / 12);
}
function amountView(cents) { return Math.round(Number(cents || 0)) / 100; }
function fdView(fd) {
  const principal = Number(fd.principal_cents ?? Math.round(Number(fd.principal || 0) * 100));
  const projectedInterest = Number(fd.projected_interest_cents ?? Math.round(Number(fd.interest_amount || 0) * 100));
  const projectedMaturity = Number(fd.projected_maturity_cents ?? Math.round(Number(fd.maturity_amount || 0) * 100));
  const openedAt = fd.opened_at || fd.created_at;
  const elapsedMonths = openedAt && fd.status === 'ACTIVE' ? monthsElapsed(new Date(openedAt), new Date(), Number(fd.tenure_months || 0)) : null;
  const estimatedPrematureInterest = fd.premature_interest_cents == null && elapsedMonths != null ? interestCents(principal, PREMATURE_RATE_BPS, elapsedMonths) : fd.premature_interest_cents;
  const estimatedPenalty = fd.penalty_cents == null && estimatedPrematureInterest != null ? Math.round(Number(estimatedPrematureInterest) * 0.10) : fd.penalty_cents;
  const estimatedSettlement = fd.settlement_cents == null && estimatedPrematureInterest != null ? principal + Number(estimatedPrematureInterest) - Number(estimatedPenalty) : fd.settlement_cents;
  return {
    ...fd,
    reference: displayId(fd._id, 'FD'),
    principal: amountView(principal),
    principal_cents: principal,
    interest_rate: Number(fd.annual_rate_bps ?? Math.round(Number(fd.interest_rate || 7.1) * 100)) / 100,
    projected_interest: amountView(projectedInterest),
    projected_maturity: amountView(projectedMaturity),
    maturity_amount: amountView(projectedMaturity),
    premature_interest: fd.premature_interest_cents == null ? null : amountView(fd.premature_interest_cents),
    penalty: fd.penalty_cents == null ? null : amountView(fd.penalty_cents),
    settlement_amount: fd.settlement_cents == null ? null : amountView(fd.settlement_cents),
    estimated_premature_interest: estimatedPrematureInterest == null ? null : amountView(estimatedPrematureInterest),
    estimated_penalty: estimatedPenalty == null ? null : amountView(estimatedPenalty),
    estimated_settlement: estimatedSettlement == null ? null : amountView(estimatedSettlement),
    calculation_method: fd.calculation_method || 'SIMPLE_INTEREST',
    maturity_instruction: fd.maturity_instruction || 'CREDIT_ACCOUNT'
  };
}
function isPrivileged(req, user) {
  const role = String(user.role || '').toLowerCase();
  const token = process.env.FD_MATURITY_WORKER_TOKEN;
  return ['admin', 'reviewer'].includes(role) || user.is_reviewer === true || Boolean(token && req.headers['x-fd-maturity-token'] === token);
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('fixed_deposits').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('fixed_deposits').createIndex({ status: 1, maturity_date: 1 }),
    db.collection('financial_transactions').createIndex({ fd_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { fd_id: { $exists: true }, idempotency_key: { $exists: true } } })
  ]);
}

async function settleMaturity(db, session, fd, now) {
  const proceeds = Number(fd.projected_maturity_cents);
  const account = await db.collection('accounts').findOne({ _id: fd.account_id, user_id: fd.user_id }, { session });
  if (!account) badRequest('Linked account not found.', 404);
  const transactionId = createId('TXN');
  const eventId = createId('AUDIT');
  const updated = await db.collection('fixed_deposits').updateOne({ _id: fd._id, status: 'ACTIVE', maturity_date: { $lte: now } }, { $set: { status: 'CLOSED', maturity_status: 'MATURED', status_history: ['ACTIVE', 'MATURED', 'CLOSED'], matured_at: now, closed_at: now, closure_type: 'MATURITY', settlement_cents: proceeds, settlement_transaction_id: transactionId, updated_at: now } }, { session });
  if (updated.modifiedCount !== 1) return null;
  await db.collection('accounts').updateOne({ _id: account._id }, { $inc: { balance: proceeds / 100 } }, { session });
  await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: fd.user_id, account_id: account._id, fd_id: fd._id, type: 'FD_MATURITY', amount_cents: proceeds, status: 'COMPLETED', created_at: now }, { session });
  await createAuditEvent(db, session, { _id: eventId, event_type: 'FD_MATURITY_CREDIT_COMPLETED', fd_id: fd._id, user_id: fd.user_id, amount_cents: proceeds, principal_cents: fd.principal_cents, interest_rate: Number(fd.annual_rate_bps || 0) / 100, tenure_months: fd.tenure_months, maturity_amount_cents: proceeds, fd_status: 'CLOSED', transaction_id: transactionId, actor_role: 'SYSTEM', outcome: 'COMPLETED' }, { request: null });
  return { fd_id: fd._id, fd_reference: displayId(fd._id, 'FD'), reference: displayId(transactionId, 'TXN'), amount: amountView(proceeds), audit_event_id: eventId };
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = authenticate(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
  const requestBody = req.body || {};
  const requestedAction = String(requestBody.action || '').toUpperCase();
  try { await ensureIndexes(db); } catch { return res.status(500).json({ error: 'FD data preparation failed.' }); }
  const session = client.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const user = await db.collection('users').findOne({ _id: payload.user_id }, { session });
      const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { session });
      if (!user || !account) badRequest('Account not found.', 404);
      if (Number(payload.token_version || 0) !== Number(user.token_version || 0)) badRequest('Your session has been revoked.', 401);
      if (user.account_status === 'SUSPENDED' || account.status === 'SUSPENDED') badRequest('This account is suspended. Financial actions are unavailable.', 403);
      if (req.method === 'GET') {
        const deposits = await db.collection('fixed_deposits').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray();
        return { account: { balance: Number(account.balance || 0), _id: account._id }, deposits: deposits.map(fdView), product: { minimum_amount: 5000, tenures: [12, 24, 36], annual_rate: 7.1, calculation_method: 'SIMPLE_INTEREST', terms_label: 'Illustrative prototype terms' } };
      }
      const body = requestBody;
      const action = String(body.action || '').toUpperCase();
      const now = new Date();
      if (action === 'OPEN') {
        const key = idempotencyKey(req, body);
        if (!key) badRequest('An idempotency key is required for FD opening.');
        const existing = await db.collection('fixed_deposits').findOne({ user_id: user._id, idempotency_key: key }, { session });
        if (existing) return { action, deposit: fdView(existing), fd_reference: displayId(existing._id, 'FD'), audit_event_id: existing.audit_event_id, new_balance: Number(account.balance || 0), idempotent: true };
        const principalCents = moneyCents(body.amount);
        if (principalCents < MINIMUM_PRINCIPAL_CENTS) badRequest('Minimum fixed deposit amount is ₹5,000.');
        const tenureMonths = Number(body.tenure_months);
        if (!SUPPORTED_TENURES.has(tenureMonths)) badRequest('FD tenure must be 12, 24 or 36 months.');
        if (body.confirmed !== true) badRequest('Please confirm the illustrative FD terms before opening.');
        if (Number(account.balance || 0) * 100 < principalCents) badRequest('Insufficient account balance.');
        const maturityDate = addMonths(now, tenureMonths);
        const projectedInterestCents = interestCents(principalCents, ANNUAL_RATE_BPS, tenureMonths);
        const projectedMaturityCents = principalCents + projectedInterestCents;
        const fdId = createId('FD');
        const transactionId = createId('TXN');
        const auditEventId = createId('AUDIT');
        const fd = { _id: fdId, user_id: user._id, account_id: account._id, idempotency_key: key, principal_cents: principalCents, annual_rate_bps: ANNUAL_RATE_BPS, interest_rate: 7.1, calculation_method: 'SIMPLE_INTEREST', tenure_months: tenureMonths, opened_at: now, created_at: now, maturity_date: maturityDate, projected_interest_cents: projectedInterestCents, projected_maturity_cents: projectedMaturityCents, maturity_instruction: 'CREDIT_ACCOUNT', status: 'ACTIVE', status_history: ['ACTIVE'], application_audit_event_id: auditEventId, audit_event_id: auditEventId };
        const debit = await db.collection('accounts').updateOne({ _id: account._id, user_id: user._id, balance: { $gte: principalCents / 100 } }, { $inc: { balance: -(principalCents / 100) } }, { session });
        if (debit.modifiedCount !== 1) badRequest('Insufficient account balance.');
        await db.collection('fixed_deposits').insertOne(fd, { session });
        await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: user._id, account_id: account._id, fd_id: fdId, idempotency_key: key, type: 'FD_OPENING', amount_cents: principalCents, status: 'COMPLETED', created_at: now }, { session });
        const fdAuditDetails = { fd_id: fdId, user_id: user._id, amount_cents: principalCents, principal_cents: principalCents, interest_rate: fd.interest_rate, tenure_months: tenureMonths, opened_at: now, maturity_date: maturityDate, maturity_amount_cents: projectedMaturityCents, fd_status: 'ACTIVE', actor_id: user._id, actor_role: 'CUSTOMER', idempotency_key: key };
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'FD_FUNDED', ...fdAuditDetails, transaction_id: transactionId, outcome: 'COMPLETED' });
        return { action, deposit: fdView(fd), fd_reference: displayId(fdId, 'FD'), reference: displayId(transactionId, 'TXN'), audit_event_id: auditEventId, new_balance: Number(account.balance || 0) - principalCents / 100 };
      }
      if (action === 'CLOSE') {
        const fdId = String(body.fd_id || body.deposit_id || '');
        const key = idempotencyKey(req, body);
        if (!key) badRequest('An idempotency key is required for FD closure.');
        const duplicate = await db.collection('financial_transactions').findOne({ user_id: user._id, fd_id: fdId, idempotency_key: key }, { session });
        if (duplicate) {
          const existingFd = await db.collection('fixed_deposits').findOne({ _id: fdId, user_id: user._id }, { session, projection: { audit_event_id: 1 } });
          return { action, reference: displayId(duplicate._id, 'TXN'), amount: amountView(duplicate.amount_cents), new_balance: Number(account.balance || 0), audit_event_id: existingFd?.audit_event_id || null, idempotent: true };
        }
        const fd = await db.collection('fixed_deposits').findOne({ _id: fdId, user_id: user._id, status: 'ACTIVE' }, { session });
        if (!fd) badRequest('Fixed deposit not found, already settled, or not owned by you.', 404);
        if (new Date(fd.maturity_date) <= now) badRequest('This FD has matured. It must be settled by the protected maturity processor.');
        const principalCents = Number(fd.principal_cents);
        const elapsedMonths = monthsElapsed(new Date(fd.opened_at), now, Number(fd.tenure_months));
        const interestPaidCents = interestCents(principalCents, PREMATURE_RATE_BPS, elapsedMonths);
        const penaltyCents = Math.round(interestPaidCents * 0.10);
        const settlementCents = principalCents + interestPaidCents - penaltyCents;
        const transactionId = createId('TXN');
        const auditEventId = createId('AUDIT');
        const updated = await db.collection('fixed_deposits').updateOne({ _id: fd._id, user_id: user._id, status: 'ACTIVE' }, { $set: { status: 'CLOSED', status_history: ['ACTIVE', 'CLOSED'], closed_at: now, closure_type: 'PREMATURE', premature_rate_bps: PREMATURE_RATE_BPS, premature_interest_cents: interestPaidCents, penalty_cents: penaltyCents, settlement_cents: settlementCents, settlement_transaction_id: transactionId, audit_event_id: auditEventId, updated_at: now } }, { session });
        if (updated.modifiedCount !== 1) badRequest('This FD was already settled.');
        const credited = await db.collection('accounts').updateOne({ _id: account._id, user_id: user._id, status: { $ne: 'SUSPENDED' } }, { $inc: { balance: settlementCents / 100 } }, { session });
        if (credited.modifiedCount !== 1) badRequest('The linked account could not be credited.');
        await db.collection('financial_transactions').insertOne({ _id: transactionId, user_id: user._id, account_id: account._id, fd_id: fd._id, idempotency_key: key, type: 'FD_PREMATURE_CLOSURE', amount_cents: settlementCents, principal_cents: principalCents, interest_cents: interestPaidCents, penalty_cents: penaltyCents, status: 'COMPLETED', created_at: now }, { session });
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'FD_PREMATURE_CLOSURE_COMPLETED', fd_id: fd._id, user_id: user._id, amount_cents: settlementCents, principal_cents: principalCents, interest_rate: PREMATURE_RATE_BPS / 100, tenure_months: fd.tenure_months, maturity_amount_cents: settlementCents, interest_paid_cents: interestPaidCents, fd_status: 'CLOSED', closure_type: 'PREMATURE', transaction_id: transactionId, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED', penalty_cents: penaltyCents });
        return { action, amount: amountView(settlementCents), principal_returned: amountView(principalCents), interest_paid: amountView(interestPaidCents), penalty: amountView(penaltyCents), reference: displayId(transactionId, 'TXN'), audit_event_id: auditEventId, new_balance: Number(account.balance || 0) + settlementCents / 100 };
      }
      if (action === 'PROCESS_MATURITY') {
        if (!isPrivileged(req, user)) badRequest('Protected maturity-worker authorization is required.', 403);
        const filter = { status: 'ACTIVE', maturity_date: { $lte: now } };
        if (body.fd_id) filter._id = String(body.fd_id);
        const eligible = await db.collection('fixed_deposits').find(filter, { session }).limit(50).toArray();
        const settled = [];
        for (const fd of eligible) { const item = await settleMaturity(db, session, fd, now); if (item) settled.push(item); }
        return { action, processed: settled.length, settlements: settled };
      }
      badRequest('Unsupported FD action.');
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    let failureAuditEventId = null;
    if (req.method === 'POST' && requestedAction === 'CLOSE' && payload?.user_id) {
      try {
        failureAuditEventId = createId('AUDIT');
        await createAuditEvent(db, null, { _id: failureAuditEventId, event_type: 'FD_PREMATURE_CLOSURE_REJECTED', fd_id: String(requestBody.fd_id || requestBody.deposit_id || '') || null, user_id: payload.user_id, actor_id: payload.user_id, actor_role: 'CUSTOMER', outcome: 'REJECTED', failure_reason: String(error.message || 'FD closure rejected').slice(0, 240) }, { auditReady: true });
      } catch { failureAuditEventId = null; }
    }
    if (error && error.code === 11000) return res.status(409).json({ success: false, error: 'This FD request was already processed or is being processed.', ...(failureAuditEventId ? { audit_event_id: failureAuditEventId } : {}) });
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, error: error.expose || status < 500 ? error.message : 'FD request could not be completed.', ...(failureAuditEventId ? { audit_event_id: failureAuditEventId } : {}) });
  } finally { await session.endSession(); }
};
