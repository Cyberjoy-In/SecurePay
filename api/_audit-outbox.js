const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');

const FALLBACK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createAuditEvent(db, session, event) {
  return db.collection('audit_events').insertOne({
    ...event,
    delivery_status: 'PENDING',
    attempts: 0,
    created_at: new Date(),
    updated_at: new Date()
  }, { session });
}

async function sendAuditToTelegram(event, image) {
  const token = getRequiredEnv('TELEGRAM_BOT_TOKEN');
  const chatId = getRequiredEnv('TELEGRAM_CHAT_ID');
  const imageData = String(image || '').replace(/^data:image\/png;base64,/, '') || FALLBACK_PNG;
  const blob = new Blob([Buffer.from(imageData, 'base64')], { type: 'image/png' });
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('photo', blob, 'securepay-audit.png');
  const amount = event.amount_cents == null ? '0.00' : (Number(event.amount_cents) / 100).toFixed(2);
  const caption = [
    'SecurePay Financial Audit',
    `Event: ${event.event_type || 'UNKNOWN'}`,
    `Event ID: ${event._id || 'UNKNOWN'}`,
    `Loan: ${event.loan_id || 'N/A'}`,
    `FD: ${event.fd_id || 'N/A'}`,
    `Card: ${event.card_id || 'N/A'}`,
    `Customer: ${event.user_id || 'UNKNOWN'}`,
    `Amount: INR ${amount}`,
    `Outcome: ${event.outcome || 'PENDING'}`,
    `Actor: ${event.actor_role || 'CUSTOMER'}`,
    `Timestamp: ${new Date(event.created_at || Date.now()).toISOString()}`
  ].join('\n');
  formData.append('caption', caption);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram audit delivery failed.');
  return result;
}

async function deliverAuditEvent(eventId, image) {
  const db = await getDatabase();
  const event = await db.collection('audit_events').findOne({ _id: eventId });
  if (!event) throw new Error('Audit event not found.');
  try {
    await sendAuditToTelegram(event, image);
    await db.collection('audit_events').updateOne({ _id: eventId }, { $set: { delivery_status: 'DELIVERED', delivered_at: new Date(), updated_at: new Date() }, $inc: { attempts: 1 } });
    return { delivered: true };
  } catch (error) {
    await db.collection('audit_events').updateOne({ _id: eventId }, { $set: { delivery_status: 'PENDING', last_error: error.message, updated_at: new Date() }, $inc: { attempts: 1 } });
    return { delivered: false, error: error.message };
  }
}

async function retryPendingAuditEvents(limit = 10) {
  const db = await getDatabase();
  const events = await db.collection('audit_events').find({ delivery_status: 'PENDING' }).sort({ created_at: 1 }).limit(limit).toArray();
  for (const event of events) await deliverAuditEvent(event._id);
}

module.exports = { createAuditEvent, deliverAuditEvent, retryPendingAuditEvents };
