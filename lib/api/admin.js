const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getClient } = require('./_db');
const { createId, displayId } = require('./_ids');
const { retryPendingAuditEvents, buildAuditDetails, enrichEventIdentity } = require('./_audit-outbox');
const { resolveRequestIp } = require('./_request-context');

const ADMIN_ROLES = new Set(['admin', 'reviewer']);
function authError(message, statusCode = 401) { throw Object.assign(new Error(message), { statusCode }); }
function badRequest(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode, expose: true }); }
function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) authError('Administrator authentication is required.');
  try { return jwt.verify(token, getRequiredEnv('JWT_SECRET')); }
  catch { authError('Your administrator session has expired.'); }
}
function page(req) { return Math.max(1, Number(req.query?.page || 1)); }
function limit(req) { return Math.min(100, Math.max(1, Number(req.query?.limit || 20))); }
function dateFilter(query, field = 'created_at') {
  const filter = {};
  if (query.from || query.to) {
    filter[field] = {};
    if (query.from) filter[field].$gte = new Date(query.from);
    if (query.to) { const end = new Date(query.to); end.setUTCHours(23, 59, 59, 999); filter[field].$lte = end; }
  }
  return filter;
}
function serialize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') { const out = {}; for (const [key, item] of Object.entries(value)) { if (!['password_hash', 'photo_data'].includes(key)) out[key] = serialize(item); } return out; }
  return value;
}
async function audit(db, event, options = {}) {
  try { await db.collection('audit_events').insertOne({ _id: createId('AUDIT'), ...event, request_ip: event.request_ip || resolveRequestIp(), audit_ready: options.auditReady !== false, delivery_status: options.deliveryStatus || 'PENDING', attempts: 0, created_at: new Date(), updated_at: new Date() }); } catch { /* access logging must not expose database details */ }
}
async function count(db, collection, filter = {}) { return db.collection(collection).countDocuments(filter); }
async function paged(collection, filter, sort, req, projection) {
  const currentPage = page(req); const size = limit(req);
  const [items, total] = await Promise.all([
    collection.find(filter, projection ? { projection } : {}).sort(sort).skip((currentPage - 1) * size).limit(size).toArray(),
    collection.countDocuments(filter)
  ]);
  return { items: serialize(items), page: currentPage, limit: size, total, pages: Math.ceil(total / size) };
}
async function customerDirectory(db, ids) {
  const userIds = [...new Set(ids.filter(Boolean).map(String))];
  if (!userIds.length) return new Map();
  const users = await db.collection('users').find({ _id: { $in: userIds } }, { projection: { password_hash: 0 } }).toArray();
  return new Map(users.map(user => [String(user._id), { id: user._id, name: user.full_name || 'Customer details unavailable', email: user.email || '' }]));
}
async function attachCustomerNames(db, items, idField = 'user_id') {
  const directory = await customerDirectory(db, items.map(item => item[idField]));
  return items.map(item => ({ ...item, customer: directory.get(String(item[idField])) || { id: item[idField] || null, name: 'Customer details unavailable', email: '' }, customer_name: directory.get(String(item[idField]))?.name || 'Customer details unavailable' }));
}
async function attachTransactionNames(db, items) {
  const accountIds = [...new Set(items.flatMap(item => [item.account_id, item.sender_account_id, item.receiver_account_id].filter(Boolean).map(String)))];
  const accounts = accountIds.length ? await db.collection('accounts').find({ _id: { $in: accountIds } }, { projection: { user_id: 1 } }).toArray() : [];
  const accountUsers = new Map(accounts.map(account => [String(account._id), String(account.user_id)]));
  return attachCustomerNames(db, items.map(item => ({ ...item, user_id: item.user_id || accountUsers.get(String(item.account_id || item.sender_account_id)) })));
}
async function attachActorNames(db, items) {
  const ids = items.flatMap(item => [item.actor_id, item.user_id]);
  const directory = await customerDirectory(db, ids);
  return items.map(item => ({ ...item, actor_name: directory.get(String(item.actor_id))?.name || (item.actor_id ? 'Administrator details unavailable' : ''), customer_name: directory.get(String(item.user_id))?.name || (item.user_id ? 'Customer details unavailable' : '') }));
}
async function adminUser(db, identity) {
  const user = await db.collection('users').findOne({ _id: identity.user_id });
  if (!user || Number(identity.token_version || 0) !== Number(user.token_version || 0) || !ADMIN_ROLES.has(String(user.role || '').toLowerCase()) || user.account_status === 'SUSPENDED') authError('Administrator access is not permitted.', 403);
  return user;
}
function searchFilter(query, fields) {
  const text = String(query.search || '').trim();
  return text ? { $or: fields.map(field => ({ [field]: { $regex: text, $options: 'i' } })) } : {};
}

async function dashboard(db) {
  const [customers, activeAccounts, suspendedAccounts, pendingLoans, approvedLoans, activeLoans, closedLoans, outstanding, activeFds, dueFds, pendingCards, activeCards, blockedCards, completedTransactions, pendingTransactions, failedTransactions, pendingAudits] = await Promise.all([
    count(db, 'users', { $or: [{ role: { $exists: false } }, { role: 'customer' }] }),
    count(db, 'accounts', { status: { $ne: 'SUSPENDED' } }),
    count(db, 'accounts', { status: 'SUSPENDED' }),
    count(db, 'loans', { status: 'UNDER_REVIEW' }), count(db, 'loans', { status: 'APPROVED' }), count(db, 'loans', { status: { $in: ['DISBURSED', 'ACTIVE'] } }), count(db, 'loans', { status: 'CLOSED' }),
    db.collection('loans').aggregate([{ $match: { status: { $in: ['DISBURSED', 'ACTIVE'] } } }, { $group: { _id: null, cents: { $sum: '$outstanding_principal_cents' } } }]).toArray(),
    db.collection('fixed_deposits').aggregate([{ $match: { status: 'ACTIVE' } }, { $group: { _id: null, cents: { $sum: '$principal_cents' } } }]).toArray(), count(db, 'fixed_deposits', { status: 'ACTIVE', maturity_date: { $lte: new Date() } }),
    count(db, 'cards', { status: { $in: ['PENDING', 'PENDING_REVIEW'] } }), count(db, 'cards', { status: 'ACTIVE' }), count(db, 'cards', { status: 'BLOCKED' }),
    count(db, 'financial_transactions', { status: 'COMPLETED' }), count(db, 'transactions', { status: { $regex: '^PENDING' } }), count(db, 'financial_transactions', { status: { $in: ['FAILED', 'REVERSED'] } }), count(db, 'audit_events', { delivery_status: 'PENDING', audit_ready: { $ne: false }, event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] } })
  ]);
  const recent = await db.collection('audit_events').find({ event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] } }).sort({ created_at: -1 }).limit(10).toArray();
  const recentActivity = (await attachActorNames(db, recent)).map(item => ({ ...item, display_reference: displayId(item.transaction_id || item.loan_id || item.fd_id || item.card_id, item.transaction_id ? 'TXN' : item.loan_id ? 'LOAN' : item.fd_id ? 'FD' : 'CARD') }));
  return { metrics: { customers, active_accounts: activeAccounts, suspended_accounts: suspendedAccounts, pending_loans: pendingLoans, approved_loans: approvedLoans, active_loans: activeLoans, closed_loans: closedLoans, outstanding_loan_principal: Number(outstanding[0]?.cents || 0) / 100, active_fd_principal: Number(activeFds[0]?.cents || 0) / 100, fds_awaiting_maturity: dueFds, pending_cards: pendingCards, active_cards: activeCards, blocked_cards: blockedCards, completed_transactions: completedTransactions, pending_transactions: pendingTransactions, failed_transactions: failedTransactions, pending_audits: pendingAudits }, recent_activity: serialize(recentActivity) };
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let identity;
  try { identity = authenticate(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
  let db;
  try { db = await (await getClient()).db(process.env.MONGODB_DB_NAME || 'securepay'); } catch { return res.status(500).json({ error: 'Database unavailable.' }); }
  let user;
  try { user = await adminUser(db, identity); } catch (error) { return res.status(error.statusCode || 403).json({ error: error.message }); }
  try {
    const section = String(req.query?.section || 'dashboard').toLowerCase();
    if (req.method === 'GET') {
      if (section === 'dashboard') return res.status(200).json({ success: true, ...(await dashboard(db)) });
      if (section === 'users') {
        const filters = { ...searchFilter(req.query || {}, ['full_name', 'email', '_id']) };
        if (req.query.status) filters.account_status = String(req.query.status).toUpperCase();
        const users = await paged(db.collection('users'), filters, { created_at: -1, _id: -1 }, req, { _id: 1, full_name: 1, email: 1, role: 1, account_status: 1, created_at: 1 });
        users.items = users.items.map(item => ({ ...item, user_reference: displayId(item._id, 'USR') }));
        return res.status(200).json({ success: true, ...users });
      }
      if (section === 'transactions') {
        const filters = { ...dateFilter(req.query || {}) };
        if (req.query.status) filters.status = String(req.query.status).toUpperCase();
        if (req.query.type) filters.type = String(req.query.type);
        if (req.query.customer) filters.user_id = String(req.query.customer);
        const projection = { _id: 1, user_id: 1, account_id: 1, sender_account_id: 1, receiver_account_id: 1, type: 1, amount_cents: 1, amount: 1, status: 1, created_at: 1, transaction_id: 1, reference: 1 };
        const [ledger, transfers] = await Promise.all([paged(db.collection('financial_transactions'), filters, { created_at: -1 }, req, projection), paged(db.collection('transactions'), filters, { created_at: -1 }, req, projection)]);
        ledger.items = await attachTransactionNames(db, ledger.items);
        transfers.items = await attachTransactionNames(db, transfers.items);
        ledger.items = ledger.items.map(item => ({ ...item, transaction_reference: displayId(item.reference || item._id, 'TXN') }));
        transfers.items = transfers.items.map(item => ({ ...item, transaction_reference: displayId(item.reference || item._id, 'TXN') }));
        return res.status(200).json({ success: true, financial: ledger, transfers });
      }
      if (section === 'loans') { const result = await paged(db.collection('loans'), { ...searchFilter(req.query || {}, ['_id', 'user_id', 'purpose']), ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}) }, { created_at: -1 }, req, { _id: 1, user_id: 1, purpose: 1, principal_cents: 1, monthly_emi_cents: 1, outstanding_cents: 1, status: 1, created_at: 1, term_months: 1 }); result.items = (await attachCustomerNames(db, result.items)).map(item => ({ ...item, loan_reference: displayId(item._id, 'LOAN') })); return res.status(200).json({ success: true, ...result }); }
      if (section === 'fds') { const result = await paged(db.collection('fixed_deposits'), { ...searchFilter(req.query || {}, ['_id', 'user_id']), ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}) }, { created_at: -1 }, req, { _id: 1, user_id: 1, principal_cents: 1, maturity_date: 1, status: 1, created_at: 1, annual_rate_bps: 1, tenure_months: 1 }); result.items = (await attachCustomerNames(db, result.items)).map(item => ({ ...item, fd_reference: displayId(item._id, 'FD') })); return res.status(200).json({ success: true, ...result }); }
      if (section === 'cards') { const result = await paged(db.collection('cards'), { ...searchFilter(req.query || {}, ['_id', 'reference', 'user_id', 'type']), ...(req.query.status ? { status: String(req.query.status).toUpperCase() } : {}) }, { created_at: -1 }, req, { _id: 1, user_id: 1, reference: 1, type: 1, last4: 1, status: 1, daily_limit_cents: 1, created_at: 1 }); result.items = (await attachCustomerNames(db, result.items)).map(item => ({ ...item, card_reference: displayId(item.reference || item._id, 'CARD') })); return res.status(200).json({ success: true, ...result }); }
      if (section === 'audit-detail') {
        const eventId = String(req.query?.id || '').trim();
        if (!eventId) return res.status(400).json({ error: 'An audit reference is required.' });
        const event = await db.collection('audit_events').findOne({ _id: eventId, event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] } });
        if (!event) return res.status(404).json({ error: 'Audit record not found.' });
        return res.status(200).json({ success: true, ...buildAuditDetails(await enrichEventIdentity(db, event)) });
      }
      if (section === 'audit') { const filters = { ...dateFilter(req.query || {}), event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] }, ...(req.query.status ? { delivery_status: String(req.query.status).toUpperCase() } : {}) }; const result = await paged(db.collection('audit_events'), filters, { created_at: -1 }, req, { _id: 1, event_type: 1, user_id: 1, actor_id: 1, business_reference: 1, transaction_reference: 1, transaction_id: 1, loan_id: 1, fd_id: 1, card_id: 1, outcome: 1, delivery_status: 1, photo_status: 1, created_at: 1 }); result.items = (await attachActorNames(db, result.items)).map(item => ({ ...item, business_reference: displayId(item.business_reference || item.transaction_reference || item.transaction_id || item.loan_id || item.fd_id || item.card_id, item.transaction_id || item.transaction_reference ? 'TXN' : item.loan_id ? 'LOAN' : item.fd_id ? 'FD' : 'CARD') || null })); return res.status(200).json({ success: true, ...result }); }
      return res.status(404).json({ error: 'Admin section not found.' });
    }

    const body = req.body || {}; const action = String(body.action || '').toUpperCase(); const now = new Date();
    if (action === 'LOAN_APPROVE' || action === 'LOAN_REJECT' || action === 'LOAN_DISBURSE') {
      const session = (await getClient()).startSession();
      try {
        const result = await session.withTransaction(async () => {
          const loan = await db.collection('loans').findOne({ _id: String(body.loan_id || '') }, { session });
          if (!loan) badRequest('Loan not found.', 404);
          if (action === 'LOAN_APPROVE') {
            if (loan.status !== 'UNDER_REVIEW') badRequest('Only loans under review can be approved.');
            const changed = await db.collection('loans').updateOne({ _id: loan._id, status: 'UNDER_REVIEW' }, { $set: { status: 'APPROVED', reviewer_id: user._id, reviewer_role: user.role, decision_at: now } }, { session });
            if (changed.modifiedCount !== 1) badRequest('Loan status changed. Refresh and try again.', 409);
            const auditId = createId('AUDIT'); await db.collection('audit_events').insertOne({ _id: auditId, event_type: 'LOAN_APPROVED', loan_id: loan._id, user_id: loan.user_id, actor_id: user._id, actor_role: user.role, outcome: 'APPROVED', request_ip: resolveRequestIp(), delivery_status: 'PENDING', attempts: 0, created_at: now, updated_at: now }, { session }); return { action, loan_id: loan._id, audit_event_id: auditId };
          }
          if (action === 'LOAN_REJECT') {
            const reason = String(body.reason || '').trim(); if (loan.status !== 'UNDER_REVIEW') badRequest('Only loans under review can be rejected.'); if (reason.length < 3 || reason.length > 500) badRequest('A rejection reason is required.');
            await db.collection('loans').updateOne({ _id: loan._id, status: 'UNDER_REVIEW' }, { $set: { status: 'REJECTED', rejection_reason: reason, reviewer_id: user._id, reviewer_role: user.role, decision_at: now } }, { session });
            const auditId = createId('AUDIT'); await db.collection('audit_events').insertOne({ _id: auditId, event_type: 'LOAN_REJECTED', loan_id: loan._id, user_id: loan.user_id, actor_id: user._id, actor_role: user.role, outcome: 'REJECTED', request_ip: resolveRequestIp(), delivery_status: 'PENDING', attempts: 0, created_at: now, updated_at: now }, { session }); return { action, loan_id: loan._id, audit_event_id: auditId };
          }
          if (loan.status !== 'APPROVED') badRequest('Only approved loans can be disbursed.');
          const borrower = await db.collection('accounts').findOne({ user_id: loan.user_id }, { session }); if (!borrower) badRequest('Borrower account not found.', 404);
          if (await db.collection('financial_transactions').findOne({ loan_id: loan._id, type: 'LOAN_DISBURSEMENT' }, { session })) badRequest('Loan was already disbursed.', 409);
          const txId = createId('TXN'); await db.collection('accounts').updateOne({ _id: borrower._id }, { $inc: { balance: Number(loan.principal_cents) / 100 } }, { session }); await db.collection('financial_transactions').insertOne({ _id: txId, user_id: loan.user_id, account_id: borrower._id, loan_id: loan._id, type: 'LOAN_DISBURSEMENT', amount_cents: Number(loan.principal_cents), status: 'COMPLETED', created_at: now }, { session }); await db.collection('loans').updateOne({ _id: loan._id, status: 'APPROVED' }, { $set: { status: 'DISBURSED', disbursed_at: now, disbursement_transaction_id: txId } }, { session }); const auditId = createId('AUDIT'); await db.collection('audit_events').insertOne({ _id: auditId, event_type: 'LOAN_DISBURSED', loan_id: loan._id, user_id: loan.user_id, actor_id: user._id, actor_role: user.role, transaction_id: txId, amount_cents: Number(loan.principal_cents), outcome: 'COMPLETED', request_ip: resolveRequestIp(), delivery_status: 'PENDING', attempts: 0, created_at: now, updated_at: now }, { session }); return { action, loan_id: loan._id, reference: txId, audit_event_id: auditId };
        });
        return res.status(200).json({ success: true, ...result });
      } finally { await session.endSession(); }
    }
    if (action === 'CARD_APPROVE' || action === 'CARD_ACTIVATE') {
      const card = await db.collection('cards').findOne({ _id: String(body.card_id || '') }); if (!card) badRequest('Card not found.', 404); const expected = action === 'CARD_APPROVE' ? { $in: ['PENDING', 'PENDING_REVIEW'] } : 'APPROVED'; const next = action === 'CARD_APPROVE' ? 'APPROVED' : 'ACTIVE'; const changed = await db.collection('cards').updateOne({ _id: card._id, status: expected }, { $set: { status: next, application_status: next, reviewer_id: user._id, reviewer_role: user.role, ...(next === 'APPROVED' ? { approved_at: now } : { activated_at: now }), updated_at: now } }); if (changed.modifiedCount !== 1) badRequest(`Card is not eligible for ${action.toLowerCase()}.`, 409); await audit(db, { event_type: action, card_id: card._id, user_id: card.user_id, actor_id: user._id, actor_role: user.role, outcome: next }); return res.status(200).json({ success: true, action, card_id: card._id, status: next });
    }
    if (action === 'AUDIT_RETRY') { const countBefore = await db.collection('audit_events').countDocuments({ delivery_status: 'PENDING', audit_ready: { $ne: false }, event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] } }); await retryPendingAuditEvents(25); return res.status(200).json({ success: true, attempted: countBefore }); }
    if (action === 'ACCOUNT_SUSPEND' || action === 'ACCOUNT_REACTIVATE') { const target = String(body.user_id || ''); if (!target || target === user._id) badRequest('A different customer account is required.'); const status = action === 'ACCOUNT_SUSPEND' ? 'SUSPENDED' : 'ACTIVE'; const changed = await db.collection('accounts').updateMany({ user_id: target }, { $set: { status, status_updated_at: now } }); await db.collection('users').updateOne({ _id: target }, { $set: { account_status: status } }); if (!changed.matchedCount) badRequest('Customer account not found.', 404); await audit(db, { event_type: action, user_id: target, actor_id: user._id, actor_role: user.role, outcome: status }); return res.status(200).json({ success: true, status }); }
    badRequest('Unsupported admin action.');
  } catch (error) { return res.status(error.statusCode || 500).json({ success: false, error: error.expose || error.message || 'Admin request failed.' }); }
};
