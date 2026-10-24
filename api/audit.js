const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { deliverAuditEvent } = require('./_audit-outbox');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');

function maskAccount(value) {
  const text = String(value || '');
  return !text ? 'Not available' : text.length <= 4 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-2)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { image, role, transaction_id, amount, user_email, audit_event_id, event_type, ipInfo, latLon, userAgent, photo_available } = body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let identity;
    try { identity = jwt.verify(token, getRequiredEnv('JWT_SECRET')); } catch { return res.status(401).json({ error: 'Authenticated audit consent is required.' }); }

    const db = await getDatabase();
    const authenticatedUser = await db.collection('users').findOne({ _id: identity.user_id }, { projection: { email: 1 } });
    if (!authenticatedUser) return res.status(401).json({ error: 'Authenticated user could not be verified.' });
    let eventId = audit_event_id;
    let event;
    if (eventId) {
      event = await db.collection('audit_events').findOne({ _id: eventId });
      if (!event || event.user_id !== identity.user_id) return res.status(403).json({ error: 'Audit event ownership could not be verified.' });
    } else {
      eventId = createId('AUDIT');
      await db.collection('audit_events').insertOne({
        _id: eventId,
        event_type: 'AUDIT_EVENT',
        transaction_id: null,
        amount_cents: 0,
        user_id: identity.user_id,
        actor_id: identity.user_id,
        actor_role: String(identity.role || 'CUSTOMER').toUpperCase(),
        outcome: 'RECORDED',
        photo_consent: true,
        delivery_status: 'PENDING',
        attempts: 0,
        created_at: new Date(),
        updated_at: new Date()
      });
      event = await db.collection('audit_events').findOne({ _id: eventId });
    }

    const owner = await db.collection('users').findOne({ _id: event.user_id || identity.user_id }, { projection: { full_name: 1, email: 1 } });
    const ownerAccount = owner && await db.collection('accounts').findOne({ user_id: owner._id }, { projection: { account_number: 1 } });

    const telemetry = {
      photo_consent: true,
      ip_info: typeof ipInfo === 'string' ? ipInfo.slice(0, 500) : null,
      request_ip: String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 100),
      ip_coordinates: typeof latLon === 'string' ? latLon.slice(0, 200) : null,
      user_agent: String(req.headers['user-agent'] || userAgent || '').slice(0, 500),
      user_email: owner?.email || authenticatedUser.email || null,
      user_name: owner?.full_name || 'Not available',
      account_number_masked: maskAccount(ownerAccount?.account_number),
      photo_status: photo_available === true || String(image).replace(/^data:image\/png;base64,/, '').length > 500 ? 'Captured' : 'Not available',
      photo_data: String(image),
      updated_at: new Date()
    };
    await db.collection('audit_events').updateOne({ _id: eventId }, { $set: { ...telemetry, audit_ready: true } });
    event = { ...event, ...telemetry };

    const delivery = await deliverAuditEvent(eventId, image);
    await db.collection('audit_logs').insertOne({
      audit_event_id: eventId,
      transaction_id: event.transaction_id || null,
      amount: Number(event.amount_cents || 0) / 100,
      user_id: event.user_id || identity.user_id,
      user_email: authenticatedUser.email || null,
      node_role: event.actor_role || 'CUSTOMER',
      ip_info: telemetry.ip_info,
      request_ip: telemetry.request_ip,
      ip_coordinates: telemetry.ip_coordinates,
      user_agent: telemetry.user_agent,
      photo_status: delivery.delivered ? 'Audit Synced' : 'Audit Pending Delivery',
      created_at: new Date()
    });

    return res.status(delivery.delivered ? 200 : 202).json({
      success: true,
      audit_event_id: eventId,
      delivery_status: delivery.delivered ? 'DELIVERED' : 'PENDING',
      message: delivery.delivered ? 'Audit logged successfully.' : 'Audit recorded and queued for delivery.'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Audit processing failed.' });
  }
};
