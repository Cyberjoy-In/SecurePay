const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');
const crypto = require('crypto');

const FALLBACK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const MAX_ATTEMPTS = 5;
const LEASE_MS = 60 * 1000;

function clean(value, fallback = 'Not available') {
  const text = String(value == null || value === '' ? fallback : value).replace(/[\r\n]+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
function money(cents) { return cents == null ? 'Not available' : `INR ${(Number(cents) / 100).toFixed(2)}`; }
function commonLines(event) {
  return [
    `Event ID: ${clean(event._id)}`,
    `Reference: ${clean(event.transaction_id || event.loan_id || event.fd_id || event.application_id)}`,
    `Time: ${new Date(event.created_at || Date.now()).toISOString()}`,
    `Status: ${clean(event.final_status || event.new_status || event.outcome)}`,
    '',
    'SECURITY & DEVICE',
    `User: ${clean(event.user_name || event.user_email || event.user_id)}`,
    `Account: ${clean(event.account_number_masked)}`,
    `IP: ${clean(event.ip_info || event.request_ip)}`,
    `Request IP: ${clean(event.request_ip)}`,
    `Location: ${clean(event.ip_coordinates)}`,
    `Device: ${clean(event.user_agent)}`,
    `Photo: ${clean(event.photo_status)}`
  ];
}
function formatAuditCaption(event) {
  const type = String(event.event_type || '').toUpperCase();
  let title = 'SECUREPAY | AUDIT EVENT';
  let lines = commonLines(event);
  if (type.startsWith('TRANSFER_') || type === 'MONEY_TRANSFER') {
    title = 'SECUREPAY | MONEY TRANSFER';
    lines = [`EVENT`, ...commonLines(event).slice(0, 4), '', 'SENDER', `Name: ${clean(event.sender_name)}`, `Account: ${clean(event.sender_account)}`, '', 'RECEIVER', `Name: ${clean(event.receiver_name)}`, `Account: ${clean(event.receiver_account)}`, '', 'TRANSACTION', `Amount: ${money(event.amount_cents)}`, `Type: ${clean(event.transaction_type)}`, `Description: ${clean(event.description)}`, ...commonLines(event).slice(5)];
  } else if (type.startsWith('LOAN_')) {
    title = 'SECUREPAY | LOAN';
    lines = ['LOAN', ...commonLines(event).slice(0, 4), `Loan ID: ${clean(event.loan_id)}`, `Principal: ${money(event.principal_cents)}`, `Interest rate: ${clean(event.interest_rate)}%`, `Tenure: ${clean(event.tenure_months)} months`, `EMI: ${money(event.emi_cents)}`, `Payment: ${money(event.payment_amount_cents)}`, `Outstanding: ${money(event.outstanding_balance_cents)}`, `Installment status: ${clean(event.installment_status)}`, '', ...commonLines(event).slice(5)];
  } else if (type.startsWith('FD_')) {
    title = 'SECUREPAY | FIXED DEPOSIT';
    lines = ['FIXED DEPOSIT', ...commonLines(event).slice(0, 4), `FD ID: ${clean(event.fd_id)}`, `Principal: ${money(event.principal_cents)}`, `Interest rate: ${clean(event.interest_rate)}%`, `Tenure: ${clean(event.tenure_months)} months`, `Maturity: ${money(event.maturity_amount_cents)}`, `FD status: ${clean(event.fd_status)}`, `Penalty: ${money(event.penalty_cents)}`, '', ...commonLines(event).slice(5)];
  } else if (type.startsWith('CARD_') || type === 'SIMULATED_CARD_PAYMENT') {
    title = 'SECUREPAY | CARD';
    lines = ['CARD', ...commonLines(event).slice(0, 4), `Card ID: ${clean(event.card_id)}`, `Application: ${clean(event.application_id)}`, `Type: ${clean(event.card_type)}`, `Last four: ${clean(event.card_last4)}`, `Status: ${clean(event.previous_status)} -> ${clean(event.new_status)}`, `Limit: ${clean(event.previous_limit)} -> ${clean(event.new_limit)} ${clean(event.currency, '')}`, `Limit type: ${clean(event.limit_type)}`, '', ...commonLines(event).slice(5)];
  }
  return `${title}\n\n${lines.join('\n')}`.slice(0, 1020);
}
async function enrichEventIdentity(db, event) {
  if (!event?.user_id || event.user_name) return event;
  const user = await db.collection('users').findOne({ _id: event.user_id }, { projection: { full_name: 1, email: 1 } });
  const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { projection: { account_number: 1 } });
  const accountNumber = account?.account_number ? String(account.account_number) : '';
  const masked = accountNumber ? `${accountNumber.slice(0, 4)}••••${accountNumber.slice(-2)}` : 'Not available';
  const identity = { user_name: user?.full_name || 'Not available', user_email: user?.email || 'Not available', account_number_masked: masked };
  await db.collection('audit_events').updateOne({ _id: event._id }, { $set: identity });
  return { ...event, ...identity };
}

function createAuditEvent(db, session, event) {
  return db.collection('audit_events').insertOne({
    ...event,
    audit_ready: false,
    delivery_status: 'PENDING',
    attempts: 0,
    created_at: new Date(),
    updated_at: new Date()
  }, { session });
}

async function sendAuditToTelegram(event, image) {
  const token = getRequiredEnv('TELEGRAM_BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const suppliedImage = String(image || '').trim();
  const imageData = suppliedImage.replace(/^data:image\/[^;]+;base64,/i, '') || FALLBACK_PNG;
  const imageBuffer = Buffer.from(imageData, 'base64');
  const blob = new Blob([imageBuffer.length ? imageBuffer : Buffer.from(FALLBACK_PNG, 'base64')], { type: 'image/png' });
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('photo', blob, 'securepay-audit.png');
  const caption = formatAuditCaption(event);
  formData.append('caption', caption);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram audit delivery failed.');
  return result;
}

async function deliverAuditEvent(eventId, image) {
  const db = await getDatabase();
  const claimToken = crypto.randomUUID();
  const now = new Date();
  const claimed = await db.collection('audit_events').updateOne(
    { _id: eventId, event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] }, audit_ready: { $ne: false }, $or: [{ delivery_status: 'PENDING', $or: [{ next_attempt_at: { $exists: false } }, { next_attempt_at: { $lte: now } }] }, { delivery_status: 'PROCESSING', lease_until: { $lte: now } }] },
    { $set: { delivery_status: 'PROCESSING', delivery_claim: claimToken, lease_until: new Date(now.getTime() + LEASE_MS), updated_at: now } }
  );
  if (claimed.modifiedCount !== 1) {
    const current = await db.collection('audit_events').findOne({ _id: eventId });
    if (!current) throw new Error('Audit event not found.');
    return { delivered: current.delivery_status === 'DELIVERED', skipped: true, error: current.delivery_status === 'PROCESSING' ? 'Audit delivery is already in progress.' : 'Audit delivery is not currently eligible.' };
  }
  const event = await enrichEventIdentity(db, await db.collection('audit_events').findOne({ _id: eventId, delivery_claim: claimToken }));
  if (!event) throw new Error('Audit event claim could not be loaded.');
  try {
    await sendAuditToTelegram(event, image || event.photo_data);
    await db.collection('audit_events').updateOne({ _id: eventId, delivery_status: 'PROCESSING', delivery_claim: claimToken }, { $set: { delivery_status: 'DELIVERED', delivered_at: new Date(), updated_at: new Date() }, $unset: { delivery_claim: '', lease_until: '', photo_data: '', next_attempt_at: '' }, $inc: { attempts: 1 } });
    return { delivered: true };
  } catch (error) {
    const attempts = Number(event.attempts || 0) + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    await db.collection('audit_events').updateOne({ _id: eventId, delivery_status: 'PROCESSING', delivery_claim: claimToken }, { $set: { delivery_status: failed ? 'FAILED' : 'PENDING', last_error: String(error.message || 'Telegram delivery failed').slice(0, 500), next_attempt_at: failed ? null : new Date(Date.now() + Math.min(60 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 10))), updated_at: new Date() }, $unset: { delivery_claim: '', lease_until: '' }, $inc: { attempts: 1 } });
    return { delivered: false, error: error.message, failed };
  }
}

async function retryPendingAuditEvents(limit = 10) {
  const db = await getDatabase();
  const now = new Date();
  const events = await db.collection('audit_events').find({ event_type: { $nin: ['ADMIN_ACCESS_GRANTED', 'ADMIN_ACCESS_DENIED'] }, audit_ready: { $ne: false }, $or: [{ delivery_status: 'PENDING', $or: [{ next_attempt_at: { $exists: false } }, { next_attempt_at: { $lte: now } }] }, { delivery_status: 'PROCESSING', lease_until: { $lte: now } }] }).sort({ created_at: 1 }).limit(limit).toArray();
  for (const event of events) await deliverAuditEvent(event._id);
}

module.exports = { createAuditEvent, deliverAuditEvent, retryPendingAuditEvents };
