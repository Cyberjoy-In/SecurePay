const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { deliverAuditEvent } = require('./_audit-outbox');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { image, role, transaction_id, amount, user_email, audit_event_id, event_type } = body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const db = await getDatabase();
    let eventId = audit_event_id;
    if (eventId) {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      let identity;
      try { identity = jwt.verify(token, getRequiredEnv('JWT_SECRET')); } catch { return res.status(401).json({ error: 'Authenticated audit consent is required.' }); }
      const existingEvent = await db.collection('audit_events').findOne({ _id: eventId });
      if (!existingEvent || existingEvent.user_id !== identity.user_id) return res.status(403).json({ error: 'Audit event ownership could not be verified.' });
      await db.collection('audit_events').updateOne({ _id: eventId }, { $set: { photo_consent: true, event_type: event_type || role || 'AUDIT_EVENT', updated_at: new Date() } });
    } else {
      eventId = createId('AUDIT');
      await db.collection('audit_events').insertOne({
        _id: eventId,
        event_type: event_type || role || 'AUDIT_EVENT',
        transaction_id: transaction_id || null,
        amount_cents: Math.round((Number(amount) || 0) * 100),
        user_reference: user_email || 'unknown',
        actor_role: 'CUSTOMER',
        outcome: 'RECORDED',
        photo_consent: true,
        delivery_status: 'PENDING',
        attempts: 0,
        created_at: new Date(),
        updated_at: new Date()
      });
    }

    const delivery = await deliverAuditEvent(eventId, image);
    await db.collection('audit_logs').insertOne({
      audit_event_id: eventId,
      transaction_id: transaction_id || null,
      amount: Number(amount) || 0,
      user_email: user_email || 'unknown',
      node_role: role || event_type || 'Unknown',
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
