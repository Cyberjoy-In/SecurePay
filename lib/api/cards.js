const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getRequiredEnv } = require('./_config');
const { getClient } = require('./_db');
const { createId, displayId } = require('./_ids');
const { createAuditEvent } = require('./_audit-outbox');
const { resolveRequestIp } = require('./_request-context');

const REVIEWER_ROLES = new Set(['reviewer', 'admin']);
const MIN_LIMIT_CENTS = 100000;
const MAX_LIMIT_CENTS = 100000000;

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 });
  try { return jwt.verify(token, getRequiredEnv('JWT_SECRET')); }
  catch { throw Object.assign(new Error('Your session has expired. Please sign in again.'), { statusCode: 401 }); }
}
function badRequest(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode, expose: true }); }
function keyOf(req, body) { return String(req.headers['idempotency-key'] || body.idempotency_key || '').trim(); }
function moneyCents(value, label = 'amount') {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) badRequest(`Enter a valid ${label}.`);
  return Math.round(number * 100);
}
function reviewerRequired(user) {
  if (!REVIEWER_ROLES.has(String(user.role || '').toLowerCase()) && user.is_reviewer !== true) badRequest('Reviewer authorization is required.', 403);
}
function dayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function cardStatus(card) {
  if (card.status === 'PENDING_REVIEW') return 'PENDING';
  return String(card.status || 'PENDING').toUpperCase();
}
function cardView(card, accountLimitCents, spentCents = 0) {
  const status = cardStatus(card);
  const limitCents = Number(card.daily_limit_cents || Math.round(Number(card.daily_limit || accountLimitCents / 100 || 100000) * 100));
  return {
    _id: card._id,
    reference: displayId(card.reference || card._id, 'CARD'),
    card_reference: displayId(card.reference || card._id, 'CARD'),
    card_type: card.type || card.card_type || 'SecurePay Platinum',
    masked_number: `•••• •••• •••• ${String(card.last4 || '0000').slice(-4)}`,
    last4: String(card.last4 || '0000').slice(-4),
    status,
    application_status: status === 'ACTIVE' || status === 'BLOCKED' ? 'APPROVED' : status,
    daily_limit: limitCents / 100,
    daily_spent: spentCents / 100,
    available_daily_limit: Math.max(0, limitCents - spentCents) / 100,
    application_date: card.application_date || card.created_at,
    approved_at: card.approved_at || null,
    activated_at: card.activated_at || null,
    blocked_at: card.blocked_at || null,
    simulated_only: true
  };
}
async function ensureIndexes(db) {
  await Promise.all([
    db.collection('cards').createIndex({ user_id: 1, reference: 1 }, { unique: true, partialFilterExpression: { reference: { $exists: true } } }),
    db.collection('card_operations').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('card_transactions').createIndex({ user_id: 1, idempotency_key: 1 }, { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } }),
    db.collection('card_transactions').createIndex({ card_id: 1, spending_day: 1, status: 1 })
  ]);
}
async function operationResult(db, session, userId, key) {
  if (!key) return null;
  return db.collection('card_operations').findOne({ user_id: userId, idempotency_key: key }, { session });
}
async function saveOperation(db, session, userId, key, result) {
  if (key) await db.collection('card_operations').insertOne({ _id: createId('CARD-OP'), user_id: userId, idempotency_key: key, result, created_at: new Date() }, { session });
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  let payload;
  try { payload = authenticate(req); } catch (error) { return res.status(error.statusCode || 401).json({ error: error.message }); }
  const client = await getClient();
  const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
  try { await ensureIndexes(db); } catch { return res.status(500).json({ error: 'Card data preparation failed.' }); }
  const session = client.startSession();
  try {
    const result = await session.withTransaction(async () => {
      const user = await db.collection('users').findOne({ _id: payload.user_id }, { session });
      const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { session });
      if (!user || !account) badRequest('Account not found.', 404);
      if (Number(payload.token_version || 0) !== Number(user.token_version || 0)) badRequest('Your session has been revoked.', 401);
      if (user.account_status === 'SUSPENDED' || account.status === 'SUSPENDED') badRequest('This account is suspended. Financial actions are unavailable.', 403);
      const accountLimitCents = Math.round(Number(account.daily_limit || 100000) * 100);

      if (req.method === 'GET') {
        const cards = await db.collection('cards').find({ user_id: user._id }, { session }).sort({ created_at: -1 }).toArray();
        const today = dayKey();
        const spent = await db.collection('card_transactions').aggregate([
          { $match: { user_id: user._id, spending_day: today, status: 'COMPLETED' } },
          { $group: { _id: '$card_id', total: { $sum: '$amount_cents' } } }
        ], { session }).toArray();
        const spentByCard = new Map(spent.map(item => [item._id, Number(item.total || 0)]));
        return { account: { _id: account._id, balance: Number(account.balance || 0), daily_limit: accountLimitCents / 100, daily_spent: spent.reduce((sum, item) => sum + Number(item.total || 0), 0) / 100 }, cards: cards.map(card => cardView(card, accountLimitCents, spentByCard.get(card._id) || 0)), simulated_transactions: true };
      }

      const body = req.body || {};
      const action = String(body.action || '').toUpperCase();
      const now = new Date();
      const key = keyOf(req, body);
      if (['APPLY', 'SET_LIMIT', 'BLOCK', 'UNBLOCK', 'SIMULATE_PAYMENT'].includes(action) && !key) badRequest('An idempotency key is required for this card action.');
      const prior = await operationResult(db, session, user._id, key);
      if (prior) return { ...prior.result, idempotent: true };

      if (action === 'APPLY' || action === 'CARD_APPLICATION') {
        const cardType = String(body.card_type || 'SecurePay Platinum').trim();
        if (!['SecurePay Platinum', 'SecurePay Classic'].includes(cardType)) badRequest('That card type is not available.');
        const cardId = createId('CARD');
        const reference = `CARD-${new Date().getUTCFullYear()}-${String(crypto.randomInt(100000, 1000000))}`;
        const auditEventId = createId('AUDIT');
        const card = { _id: cardId, reference, user_id: user._id, type: cardType, last4: String(crypto.randomInt(1000, 10000)), status: 'PENDING', application_status: 'PENDING', application_date: now, created_at: now, daily_limit_cents: accountLimitCents, audit_event_id: auditEventId };
        await db.collection('cards').insertOne(card, { session });
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'CARD_APPLICATION_SUBMITTED', card_id: cardId, application_id: reference, card_type: cardType, card_last4: card.last4, previous_status: null, new_status: 'PENDING', user_id: user._id, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'PENDING' });
        const response = { action: 'APPLY', card: cardView(card, accountLimitCents), audit_event_id: auditEventId };
        await saveOperation(db, session, user._id, key, response);
        return response;
      }

      if (action === 'APPROVE' || action === 'ACTIVATE') {
        reviewerRequired(user);
        const card = await db.collection('cards').findOne({ _id: String(body.card_id || '') }, { session });
        if (!card) badRequest('Card application not found.', 404);
        const expected = action === 'APPROVE' ? 'PENDING' : 'APPROVED';
        if (cardStatus(card) !== expected) badRequest(`Only ${expected.toLowerCase()} cards can be ${action.toLowerCase()}d.`);
        const next = action === 'APPROVE' ? 'APPROVED' : 'ACTIVE';
        const fields = { status: next, application_status: next, reviewer_id: user._id, reviewer_role: user.role || 'reviewer', updated_at: now };
        if (action === 'APPROVE') fields.approved_at = now; else fields.activated_at = now;
        await db.collection('cards').updateOne({ _id: card._id, status: expected }, { $set: fields }, { session });
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: `CARD_${action}_DECISION`, card_id: card._id, application_id: card.reference || card._id, card_type: card.type || card.card_type, card_last4: card.last4, previous_status: expected, new_status: next, user_id: card.user_id, actor_id: user._id, actor_role: user.role || 'reviewer', outcome: next });
        return { action, card_id: card._id, status: next, audit_event_id: auditEventId };
      }

      const card = await db.collection('cards').findOne({ _id: String(body.card_id || ''), user_id: user._id }, { session });
      if (!card) badRequest('Card not found or not owned by you.', 404);
      if (action === 'BLOCK' || action === 'UNBLOCK') {
        const current = cardStatus(card);
        const expected = action === 'BLOCK' ? 'ACTIVE' : 'BLOCKED';
        if (current !== expected) badRequest(`Only your ${expected.toLowerCase()} card can be ${action.toLowerCase()}ed.`);
        const next = action === 'BLOCK' ? 'BLOCKED' : 'ACTIVE';
        const update = { status: next, application_status: 'APPROVED', updated_at: now };
        if (next === 'BLOCKED') update.blocked_at = now; else update.unblocked_at = now;
        const changed = await db.collection('cards').updateOne({ _id: card._id, user_id: user._id, status: expected }, { $set: update }, { session });
        if (changed.modifiedCount !== 1) badRequest('Card status changed. Refresh and try again.');
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: `CARD_${action}ED`, card_id: card._id, application_id: card.reference || card._id, card_type: card.type || card.card_type, card_last4: card.last4, previous_status: current, new_status: next, user_id: user._id, actor_id: user._id, actor_role: 'CUSTOMER', outcome: next });
        const response = { action, card_id: card._id, status: next, audit_event_id: auditEventId };
        await saveOperation(db, session, user._id, key, response);
        return response;
      }
      if (action === 'SET_LIMIT' || action === 'DAILY_LIMIT_UPDATE') {
        const limitCents = moneyCents(body.limit, 'daily limit');
        if (limitCents < MIN_LIMIT_CENTS || limitCents > MAX_LIMIT_CENTS) badRequest('Daily limit must be between ₹1,000 and ₹10,00,000.');
        const previousLimitCents = Math.round(Number(account.daily_limit == null ? accountLimitCents / 100 : account.daily_limit) * 100);
        if (previousLimitCents === limitCents) badRequest('The daily card limit is already set to that amount.', 409);
        await db.collection('accounts').updateOne({ _id: account._id, user_id: user._id }, { $set: { daily_limit: limitCents / 100, daily_limit_updated_at: now } }, { session });
        await db.collection('cards').updateMany({ user_id: user._id }, { $set: { daily_limit_cents: limitCents, daily_limit_updated_at: now } }, { session });
        const auditEventId = createId('AUDIT');
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'CARD_LIMIT_CHANGED', user_id: user._id, account_id: account._id, previous_limit: previousLimitCents / 100, new_limit: limitCents / 100, limit_type: 'DAILY_CARD_SPENDING', currency: 'INR', amount_cents: limitCents, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED' });
        const response = { action: 'SET_LIMIT', limit: limitCents / 100, audit_event_id: auditEventId };
        await saveOperation(db, session, user._id, key, response);
        return response;
      }
      if (action === 'SIMULATE_PAYMENT') {
        const amountCents = moneyCents(body.amount, 'simulated card payment');
        const current = cardStatus(card);
        if (current !== 'ACTIVE') badRequest(current === 'BLOCKED' ? 'Blocked cards cannot be used for simulated transactions.' : 'Only active cards can be used for simulated transactions.');
        const today = dayKey(now);
        const currentCard = await db.collection('cards').findOne({ _id: card._id, user_id: user._id }, { session });
        if (currentCard.spending_day !== today) {
          await db.collection('cards').updateOne({ _id: card._id, user_id: user._id }, { $set: { spending_day: today, daily_spent_cents: 0 } }, { session });
          currentCard.daily_spent_cents = 0;
        }
        const limitCents = Number(currentCard.daily_limit_cents || accountLimitCents);
        const spentCents = Number(currentCard.daily_spent_cents || 0);
        const updated = await db.collection('cards').updateOne({ _id: card._id, user_id: user._id, status: 'ACTIVE', spending_day: today, daily_spent_cents: { $lte: limitCents - amountCents } }, { $inc: { daily_spent_cents: amountCents } }, { session });
        if (updated.modifiedCount !== 1) badRequest('Daily card limit exceeded.');
        const transactionId = createId('TXN');
        const auditEventId = createId('AUDIT');
        await db.collection('card_transactions').insertOne({ _id: transactionId, user_id: user._id, card_id: card._id, idempotency_key: key, type: 'SIMULATED_CARD_PAYMENT', amount_cents: amountCents, spending_day: today, status: 'COMPLETED', created_at: now }, { session });
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'SIMULATED_CARD_PAYMENT', card_id: card._id, application_id: card.reference || card._id, card_type: card.type || card.card_type, card_last4: card.last4, previous_status: current, new_status: current, user_id: user._id, amount_cents: amountCents, transaction_id: transactionId, actor_id: user._id, actor_role: 'CUSTOMER', outcome: 'COMPLETED' });
        const response = { action, simulated: true, reference: displayId(transactionId, 'TXN'), amount: amountCents / 100, daily_spent: (spentCents + amountCents) / 100, daily_limit: limitCents / 100, audit_event_id: auditEventId };
        await saveOperation(db, session, user._id, key, response);
        return response;
      }
      badRequest('Unsupported card action.');
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error && error.code === 11000) return res.status(409).json({ success: false, error: 'This card request was already processed or is being processed.' });
    try {
      const attemptedAction = String((req.body || {}).action || '').toUpperCase();
      if (attemptedAction) {
        const requestedCardId = String((req.body || {}).card_id || '');
        const failedCard = requestedCardId ? await db.collection('cards').findOne({ _id: requestedCardId, user_id: payload.user_id }, { projection: { _id: 1, reference: 1, type: 1, last4: 1, status: 1 } }) : null;
    await db.collection('audit_events').insertOne({ _id: createId('AUDIT'), event_type: 'CARD_ACTION_FAILED', card_id: failedCard?._id || null, application_id: failedCard?.reference || null, card_type: failedCard?.type || null, card_last4: failedCard?.last4 || null, previous_status: failedCard?.status || null, user_id: payload.user_id, actor_id: payload.user_id, actor_role: String(payload.role || 'CUSTOMER'), outcome: 'REJECTED', failure_reason: String(error.message || 'Card action failed').slice(0, 240), request_ip: resolveRequestIp(), created_at: new Date(), updated_at: new Date(), delivery_status: 'PENDING', attempts: 0 });
      }
    } catch { /* audit failure must not replace the original safe response */ }
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, error: error.expose || status < 500 ? error.message : 'Card request could not be completed.' });
  } finally { await session.endSession(); }
};
