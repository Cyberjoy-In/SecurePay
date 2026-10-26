const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { deliverAuditEvent } = require('./_audit-outbox');
const { requireUser, verifyRequest } = require('./_auth');
const { allowRequest } = require('./_rate-limit');
const { resolveRequestIp } = require('./_request-context');

function maskAccount(value) {
  const text = String(value || '');
  return !text ? 'Not available' : text.length <= 4 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-2)}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowRequest(req, 'audit', 30)) return res.status(429).json({ error: 'Audit requests are temporarily rate limited.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { image, audit_event_id, ipInfo, latLon, userAgent, photo_available, photo_consent } = body;
    if (image != null && typeof image !== 'string') return res.status(400).json({ error: 'Invalid audit image.' });
    if (typeof image === 'string' && image.length > 5_000_000) return res.status(413).json({ error: 'Audit image is too large.' });
    verifyRequest(req);

    const db = await getDatabase();
    let identity;
    let authenticatedUser;
    try {
      ({ identity, user: authenticatedUser } = await requireUser(req, db));
    } catch (error) {
      return res.status(error.statusCode || 401).json({ error: error.message });
    }
    let eventId = audit_event_id;
    let event;
    if (eventId) {
      event = await db.collection('audit_events').findOne({ _id: eventId });
      if (!event || event.user_id !== identity.user_id) return res.status(403).json({ error: 'Audit event ownership could not be verified.' });
    } else {
      eventId = createId('AUDIT');
      await db.collection('audit_events').insertOne({
        _id: eventId,
        event_type: 'SECURITY_TELEMETRY',
        transaction_id: null,
        amount_cents: 0,
        user_id: identity.user_id,
        actor_id: identity.user_id,
        actor_role: String(identity.role || 'CUSTOMER').toUpperCase(),
        outcome: 'RECORDED',
        request_ip: resolveRequestIp(req),
        photo_consent: photo_consent === true,
        audit_ready: false,
        delivery_status: 'PENDING',
        attempts: 0,
        created_at: new Date(),
        updated_at: new Date()
      });
      event = await db.collection('audit_events').findOne({ _id: eventId });
    }

    const owner = await db.collection('users').findOne({ _id: event.user_id || identity.user_id }, { projection: { full_name: 1, email: 1 } });
    const ownerAccount = owner && await db.collection('accounts').findOne({ user_id: owner._id }, { projection: { account_number: 1 } });

    const consentedPhoto = photo_consent === true;
    const imageValue = String(image || '');
    const telemetry = {
      photo_consent: consentedPhoto,
      photo_consent_at: consentedPhoto ? new Date() : null,
      ip_info: typeof ipInfo === 'string' ? ipInfo.slice(0, 500) : null,
      request_ip: resolveRequestIp(req),
      ip_coordinates: typeof latLon === 'string' ? latLon.slice(0, 200) : null,
      ip_coordinates_source: latLon ? 'client-reported' : null,
      user_agent: String(req.headers['user-agent'] || userAgent || '').slice(0, 500),
      user_email: owner?.email || authenticatedUser.email || null,
      user_name: owner?.full_name || 'Not available',
      account_number_masked: maskAccount(ownerAccount?.account_number),
      photo_status: consentedPhoto && photo_available === true && imageValue.replace(/^data:image\/[^;]+;base64,/i, '').length > 500 ? 'Captured' : consentedPhoto ? 'Unavailable' : 'Declined',
      updated_at: new Date()
    };
    const update = { $set: { ...telemetry, audit_ready: true } };
    if (telemetry.photo_status === 'Captured') update.$set.photo_data = imageValue.slice(0, 5_000_000);
    else update.$unset = { photo_data: '' };
    await db.collection('audit_events').updateOne({ _id: eventId }, update);
    event = { ...event, ...telemetry };

    const delivery = await deliverAuditEvent(eventId, telemetry.photo_status === 'Captured' ? imageValue : null);
    await db.collection('audit_logs').insertOne({
      audit_event_id: eventId,
      event_type: event.event_type,
      transaction_id: event.transaction_id || null,
      amount: Number(event.amount_cents || 0) / 100,
      user_id: event.user_id || identity.user_id,
      user_email: authenticatedUser.email || null,
      node_role: event.actor_role || 'CUSTOMER',
      ip_info: telemetry.ip_info,
      request_ip: telemetry.request_ip,
      ip_coordinates: telemetry.ip_coordinates,
      user_agent: telemetry.user_agent,
      photo_consent: telemetry.photo_consent,
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
    const status = error.statusCode || 500;
    return res.status(status).json({ error: status < 500 ? error.message : 'Audit processing failed.' });
  }
};
