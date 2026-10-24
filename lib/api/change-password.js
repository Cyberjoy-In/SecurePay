const bcrypt = require('bcrypt');
const { getClient } = require('./_db');
const { requireUser } = require('./_auth');
const { createId } = require('./_ids');
const { createAuditEvent } = require('./_audit-outbox');
const { allowRequest } = require('./_rate-limit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowRequest(req, 'change-password', 8)) return res.status(429).json({ error: 'Too many password-change attempts. Try again shortly.' });

  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const { current_password, new_password } = req.body || {};
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\W).{6,}$/;

  if (!token) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new passwords are required.' });
  if (!passwordRegex.test(new_password)) {
    return res.status(400).json({ error: 'New password must be at least 6 characters and include uppercase, lowercase, and a special symbol.' });
  }

  try {
    const client = await getClient();
    const db = client.db(process.env.MONGODB_DB_NAME || 'securepay');
    const users = db.collection('users');
    const { user } = await requireUser(req, db);

    if (!user || !await bcrypt.compare(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    if (await bcrypt.compare(new_password, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from your current password.' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    const session = client.startSession();
    const auditEventId = createId('AUDIT');
    try {
      await session.withTransaction(async () => {
        const changed = await users.updateOne({ _id: user._id, token_version: Number(user.token_version || 0) }, { $set: { password_hash, password_updated_at: new Date() }, $inc: { token_version: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw Object.assign(new Error('Your session has changed. Please sign in again.'), { statusCode: 409 });
        await createAuditEvent(db, session, { _id: auditEventId, event_type: 'PASSWORD_CHANGED', user_id: user._id, actor_id: user._id, actor_role: String(user.role || 'customer').toUpperCase(), outcome: 'COMPLETED' }, { auditReady: true });
      });
    } finally { await session.endSession(); }

    return res.status(200).json({ success: true, message: 'Password updated successfully. Sign in again with your new password.', audit_event_id: auditEventId });
  } catch (error) {
    if (error.statusCode === 401 || error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    return res.status(500).json({ error: 'Unable to update password right now.' });
  }
};
