const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');
const crypto = require('crypto');
const { displayId } = require('./_ids');
const { resolveRequestIp, currentRequest, normalizeIp } = require('./_request-context');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60 * 1000;

function clean(value, fallback = 'Not available') {
  const text = String(value == null || value === '' ? fallback : value).replace(/[\r\n]+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
function money(cents) { return cents == null ? 'Not available' : `INR ${(Number(cents) / 100).toFixed(2)}`; }
function displayIp(value) { return normalizeIp(value); }
function eventTime(event) {
  const date = new Date(event.created_at || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return { date: `${values.year}-${values.month}-${values.day}`, timestamp: `${values.hour}:${values.minute}:${values.second}.${milliseconds} IST` };
}
function rawBusinessReference(event) { return event.transaction_reference || event.transaction_id || event.loan_id || event.fd_id || event.card_id || event.application_id || null; }
function referencePrefix(value, fallback = 'REF') {
  const prefix = String(value || '').split('-', 1)[0].toUpperCase();
  return ['TXN', 'RPL', 'LOAN', 'LN', 'FD', 'CARD', 'CR'].includes(prefix) ? prefix : fallback;
}
function businessReference(event) {
  if (event.business_reference) return displayId(event.business_reference, referencePrefix(event.business_reference));
  if (event.transaction_reference) return displayId(event.transaction_reference, 'TXN');
  if (event.transaction_id) return displayId(event.transaction_id, 'TXN');
  if (event.loan_id) return displayId(event.loan_id, 'LOAN');
  if (event.fd_id) return displayId(event.fd_id, 'FD');
  if (event.card_id) return displayId(event.card_id, 'CARD');
  if (event.application_id) return displayId(event.application_id, 'CARD');
  return null;
}
function commonLines(event) {
  const time = eventTime(event);
  const reference = businessReference(event);
  return [
    reference ? `🧾 Reference: ${clean(reference)}` : null,
    `✅ Status: ${clean(event.final_status || event.new_status || event.outcome)}`,
    `📅 Date: ${time.date}`,
    `🕒 Time: ${time.timestamp}`,
    '',
    '🔐 SECURITY',
    `👤 User: ${clean(event.user_name || event.user_email)}`,
    `✉️ Email: ${clean(event.user_email)}`,
    `🏦 Account: ${clean(event.account_number_masked)}`,
    `🌐 IP Address: ${clean(displayIp(event.request_ip))}`,
    `📍 Location: ${clean(event.ip_coordinates)}`,
    `📱 Device: ${clean(event.user_agent)}`,
    `📷 Photo: ${clean(event.photo_status)}`
  ].filter(line => line !== null);
}
function transferCommonLines(event) {
  const time = eventTime(event);
  return [
    '🌐 NETWORK & DEVICE',
    `🌐 IP Address: ${clean(displayIp(event.request_ip))}`,
    `📱 Device: ${clean(event.user_agent)}`,
    `📍 Location: ${clean(event.ip_coordinates)}`,
    '',
    '📷 PHOTO AUDIT',
    `Status: ${clean(event.photo_status)}`,
    '',
    `📅 Date: ${time.date}`,
    `🕒 Time: ${time.timestamp}`
  ];
}
function formatAuditCaption(event) {
  const type = String(event.event_type || '').toUpperCase();
  const status = String(event.final_status || event.new_status || event.outcome || 'RECORDED').replaceAll('_', ' ');
  let title = `🔔 ${type.replaceAll('_', ' ')} · ${status}`;
  let lines = commonLines(event);
  if (type.startsWith('TRANSFER_') || type === 'MONEY_TRANSFER') {
    const auditParty = type === 'TRANSFER_INITIATED' ? 'SENDER' : type === 'TRANSFER_COMPLETED' ? 'RECEIVER' : 'PARTICIPANTS';
    const reference = businessReference(event);
    title = `💸 TRANSFER AUDIT — ${auditParty}`;
    const partyLines = auditParty === 'SENDER'
      ? ['👤 SENDER DETAILS', `Name: ${clean(event.sender_name || event.user_name)}`, `Account: ${clean(event.sender_account || event.account_number_masked)}`, '', '💰 TRANSACTION DETAILS', reference ? `Transaction ID: ${clean(reference)}` : null, 'Type: Debit / Outgoing Transfer', `Amount: ${money(event.amount_cents)}`, `Receiver: ${clean(event.receiver_name)}`, `Receiver Account: ${clean(event.receiver_account)}`]
      : auditParty === 'RECEIVER'
        ? ['👤 RECEIVER DETAILS', `Name: ${clean(event.receiver_name || event.user_name)}`, `Account: ${clean(event.receiver_account || event.account_number_masked)}`, '', '💰 TRANSACTION DETAILS', reference ? `Transaction ID: ${clean(reference)}` : null, 'Type: Credit / Incoming Transfer', `Amount: ${money(event.amount_cents)}`, `Sender: ${clean(event.sender_name)}`, `Sender Account: ${clean(event.sender_account)}`]
        : ['👤 PARTICIPANTS', `Sender: ${clean(event.sender_name)}`, `Receiver: ${clean(event.receiver_name)}`, '', '💰 TRANSACTION DETAILS', reference ? `Transaction ID: ${clean(reference)}` : null, `Amount: ${money(event.amount_cents)}`];
    lines = [...partyLines.filter(line => line !== null), '', ...transferCommonLines(event)];
  } else if (type.startsWith('LOAN_')) {
    title = `🏦 LOAN ${status}`;
    lines = [`👤 Applicant: ${clean(event.user_name || event.user_email)}`, `🧾 Loan: ${clean(displayId(event.loan_id, 'LOAN'))}`, `🎯 Purpose: ${clean(event.purpose)}`, `💼 Declared income: ${money(event.monthly_income_cents)}`, `💰 ${type.includes('APPLICATION') ? 'Requested' : 'Principal'}: ${money(event.principal_cents)}`, `📈 Interest: ${clean(event.interest_rate)}%`, `📆 Tenure: ${clean(event.tenure_months)} months`, `💳 EMI: ${money(event.emi_cents)}`, `💵 Payment: ${money(event.payment_amount_cents)}`, `📊 Outstanding: ${money(event.outstanding_balance_cents)}`, `🧾 Repayment: ${clean(event.repayment_reference || event.transaction_id && displayId(event.transaction_id, 'RPL'))}`, `📌 Installment: ${clean(event.installment_status)}`, '', ...commonLines(event)];
  } else if (type.startsWith('FD_')) {
    title = `💰 FIXED DEPOSIT ${status}`;
    lines = [`👤 Holder: ${clean(event.user_name || event.user_email)}`, `🧾 FD: ${clean(displayId(event.fd_id, 'FD'))}`, `💰 Principal: ${money(event.principal_cents)}`, `📈 Interest: ${clean(event.interest_rate)}%`, `📆 Tenure: ${clean(event.tenure_months)} months`, `🗓 Opened: ${event.opened_at ? new Date(event.opened_at).toISOString() : 'Not available'}`, `🗓 Maturity: ${event.maturity_date ? new Date(event.maturity_date).toISOString() : 'Not available'}`, `💵 Maturity / settlement: ${money(event.maturity_amount_cents)}`, `📉 Interest paid: ${money(event.interest_paid_cents)}`, `⚠️ Penalty: ${money(event.penalty_cents)}`, `📌 FD status: ${clean(event.fd_status)}`, '', ...commonLines(event)];
  } else if (type.startsWith('CARD_') || type === 'SIMULATED_CARD_PAYMENT') {
    title = `💳 CARD ${status}`;
    lines = [`👤 Holder: ${clean(event.user_name || event.user_email)}`, `🧾 Card: ${clean(displayId(event.card_id, 'CARD'))}`, `📄 Request: ${clean(displayId(event.application_id, 'CARD'))}`, `🏷 Type: ${clean(event.card_type)}`, `🔢 Last four: ${clean(event.card_last4)}`, `🔄 Status: ${clean(event.previous_status)} → ${clean(event.new_status)}`, `💰 Limit: ${clean(event.previous_limit)} → ${clean(event.new_limit)} ${clean(event.currency, '')}`, `📌 Limit type: ${clean(event.limit_type)}`, '', ...commonLines(event)];
  }
  return `${title}\n\n${lines.join('\n')}`.slice(0, 1020);
}
function detailValue(value) { return value == null || value === '' ? null : String(value); }
function detailMoney(cents) { return cents == null ? null : money(cents); }
function detailDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function detailField(label, value) { return { label, value: detailValue(value) }; }
function commonDetailFields(event, time, reference) {
  return [
    detailField('Event type', event.event_type),
    detailField('Reference', reference),
    detailField('Status', event.final_status || event.new_status || event.outcome),
    detailField('Outcome', event.outcome),
    detailField('Delivery', event.delivery_status),
    detailField('Date', time.date),
    detailField('Time', time.timestamp),
    detailField('User', event.user_name || event.user_email),
    detailField('Email', event.user_email),
    detailField('Account', event.account_number_masked),
    detailField('Actor role', event.actor_role),
    detailField('IP Address', displayIp(event.request_ip)),
    detailField('Location', event.ip_coordinates),
    detailField('Device', event.user_agent),
    detailField('Photo status', event.photo_status),
    detailField('Photo consent', event.photo_consent == null ? null : event.photo_consent ? 'Granted' : 'Declined')
  ];
}
function buildAuditDetails(event) {
  const type = String(event.event_type || '').toUpperCase();
  const time = eventTime(event);
  const reference = businessReference(event);
  const sections = [];
  if (type.startsWith('TRANSFER_') || type === 'MONEY_TRANSFER') {
    const party = type === 'TRANSFER_INITIATED' ? 'SENDER' : type === 'TRANSFER_COMPLETED' ? 'RECEIVER' : 'PARTICIPANTS';
    sections.push({ title: `${party} DETAILS`, fields: party === 'SENDER' ? [detailField('Name', event.sender_name || event.user_name), detailField('Account', event.sender_account || event.account_number_masked)] : party === 'RECEIVER' ? [detailField('Name', event.receiver_name || event.user_name), detailField('Account', event.receiver_account || event.account_number_masked)] : [detailField('Sender', event.sender_name), detailField('Sender account', event.sender_account), detailField('Receiver', event.receiver_name), detailField('Receiver account', event.receiver_account)] });
    sections.push({ title: 'TRANSACTION DETAILS', fields: [detailField('Transaction reference', reference), detailField('Type', party === 'SENDER' ? 'Debit / Outgoing Transfer' : party === 'RECEIVER' ? 'Credit / Incoming Transfer' : event.transaction_type), detailField('Amount', detailMoney(event.amount_cents)), detailField('Currency', event.currency), detailField('Sender', event.sender_name), detailField('Sender account', event.sender_account), detailField('Receiver', event.receiver_name), detailField('Receiver account', event.receiver_account)] });
  } else if (type.startsWith('LOAN_')) {
    sections.push({ title: 'LOAN DETAILS', fields: [detailField('Loan reference', displayId(event.loan_id, 'LOAN')), detailField('Applicant', event.user_name || event.user_email), detailField('Purpose', event.purpose), detailField('Declared income', detailMoney(event.monthly_income_cents)), detailField(type.includes('APPLICATION') ? 'Requested amount' : 'Principal', detailMoney(event.principal_cents)), detailField('Interest rate', event.interest_rate == null ? null : `${event.interest_rate}%`), detailField('Tenure', event.tenure_months == null ? null : `${event.tenure_months} months`), detailField('EMI', detailMoney(event.emi_cents)), detailField('Payment', detailMoney(event.payment_amount_cents)), detailField('Outstanding', detailMoney(event.outstanding_balance_cents)), detailField('Repayment reference', displayId(event.repayment_reference, 'RPL')), detailField('Installment', event.installment_status)] });
  } else if (type.startsWith('FD_')) {
    sections.push({ title: 'FIXED DEPOSIT DETAILS', fields: [detailField('FD reference', displayId(event.fd_id, 'FD')), detailField('Related transaction', displayId(event.transaction_id, 'TXN')), detailField('Holder', event.user_name || event.user_email), detailField('Principal', detailMoney(event.principal_cents)), detailField('Interest rate', event.interest_rate == null ? null : `${event.interest_rate}%`), detailField('Tenure', event.tenure_months == null ? null : `${event.tenure_months} months`), detailField('Opened', detailDate(event.opened_at)), detailField('Maturity date', detailDate(event.maturity_date)), detailField('Maturity / settlement', detailMoney(event.maturity_amount_cents)), detailField('Interest paid', detailMoney(event.interest_paid_cents)), detailField('Penalty', detailMoney(event.penalty_cents)), detailField('FD status', event.fd_status), detailField('Closure type', event.closure_type)] });
  } else if (type.startsWith('CARD_') || type === 'SIMULATED_CARD_PAYMENT') {
    sections.push({ title: 'CARD DETAILS', fields: [detailField('Card reference', displayId(event.card_id, 'CARD')), detailField('Application reference', displayId(event.application_id, 'CARD')), detailField('Holder', event.user_name || event.user_email), detailField('Card type', event.card_type), detailField('Last four digits', event.card_last4 ? `•••• ${event.card_last4}` : null), detailField('Previous status', event.previous_status), detailField('New status', event.new_status), detailField('Previous limit', event.previous_limit), detailField('New limit', event.new_limit), detailField('Currency', event.currency), detailField('Limit type', event.limit_type)] });
  } else {
    sections.push({ title: 'ACTION DETAILS', fields: [detailField('Event type', type), detailField('Actor role', event.actor_role), detailField('Reason', event.failure_reason || event.reason), detailField('Provider', event.provider), detailField('Service type', event.bill_type), detailField('Transaction type', event.transaction_type), detailField('Closure type', event.closure_type)] });
  }
  sections.push({ title: 'SECURITY & AUDIT', fields: commonDetailFields(event, time, reference) });
  return { event_type: type, sections, photo_included: false };
}
async function enrichEventIdentity(db, event) {
  if (!event?.user_id) return event;
  let identity = {};
  if (!event.user_name || !event.user_email || !event.account_number_masked) {
    const user = await db.collection('users').findOne({ _id: event.user_id }, { projection: { full_name: 1, email: 1 } });
    const account = user && await db.collection('accounts').findOne({ user_id: user._id }, { projection: { account_number: 1 } });
    const accountNumber = account?.account_number ? String(account.account_number) : '';
    const masked = accountNumber ? `${accountNumber.slice(0, 4)}••••${accountNumber.slice(-2)}` : 'Not available';
    identity = {
      user_name: event.user_name || user?.full_name || 'Not available',
      user_email: event.user_email || user?.email || 'Not available',
      account_number_masked: event.account_number_masked || masked
    };
  }
  const rawReference = rawBusinessReference(event);
  const referencePrefix = event.transaction_reference || event.transaction_id ? 'TXN' : event.loan_id ? 'LOAN' : event.fd_id ? 'FD' : 'CARD';
  const business_reference = rawReference ? displayId(rawReference, referencePrefix) : null;
  await db.collection('audit_events').updateOne({ _id: event._id }, { $set: { ...identity, ...(business_reference ? { business_reference } : {}) } });
  return { ...event, ...identity, ...(business_reference ? { business_reference } : {}) };
}

function createAuditEvent(db, session, event, options = {}) {
  const request = Object.prototype.hasOwnProperty.call(options, 'request') ? options.request : currentRequest();
  const requestIp = event.request_ip || resolveRequestIp(request);
  return db.collection('audit_events').insertOne({
    ...event,
    request_ip: requestIp || null,
    audit_ready: options.auditReady === true,
    delivery_status: 'PENDING',
    attempts: 0,
    created_at: new Date(),
    updated_at: new Date()
  }, { session });
}

async function sendAuditToTelegram(event, image) {
  const token = getRequiredEnv('TELEGRAM_BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const caption = formatAuditCaption(event);
  const suppliedImage = String(image || '').trim();
  let response;
  if (suppliedImage) {
    const mime = (suppliedImage.match(/^data:(image\/(?:jpeg|png|webp));base64,/i) || [])[1] || 'image/jpeg';
    const imageData = suppliedImage.replace(/^data:image\/[^;]+;base64,/i, '');
    const imageBuffer = Buffer.from(imageData, 'base64');
    if (!imageBuffer.length) throw new Error('Consented audit photo could not be decoded.');
    const blob = new Blob([imageBuffer], { type: mime });
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('photo', blob, `securepay-audit.${mime.split('/')[1]}`);
    formData.append('caption', caption);
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
  } else {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: caption }) });
  }
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

module.exports = { createAuditEvent, deliverAuditEvent, retryPendingAuditEvents, formatAuditCaption, buildAuditDetails, enrichEventIdentity };
