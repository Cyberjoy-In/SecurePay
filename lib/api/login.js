const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');
const { createId } = require('./_ids');
const { allowRequest } = require('./_rate-limit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowRequest(req, 'login', 12)) return res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  try {
    const db = await getDatabase();
    const user = await db.collection('users').findOne({ email: normalizedEmail });
    const account = user && await db.collection('accounts').findOne({ user_id: user._id });

    if (user && account && user.account_status !== 'SUSPENDED' && account.status !== 'SUSPENDED' && typeof password === 'string' && await bcrypt.compare(password, user.password_hash)) {
      const role = String(user.role || 'customer').toLowerCase();
      if (role === 'admin' || role === 'reviewer') await db.collection('audit_events').insertOne({ _id: createId('AUDIT'), event_type: 'ADMIN_LOGIN_SUCCESS', user_id: user._id, actor_id: user._id, actor_role: role, outcome: 'AUTHORIZED', delivery_status: 'RECORDED', attempts: 0, created_at: new Date(), updated_at: new Date() });
      const tokenOptions = { expiresIn: '7d' };
      if (process.env.JWT_ISSUER) tokenOptions.issuer = process.env.JWT_ISSUER;
      if (process.env.JWT_AUDIENCE) tokenOptions.audience = process.env.JWT_AUDIENCE;
      const token = jwt.sign({ user_id: user._id, role, token_version: Number(user.token_version || 0) }, getRequiredEnv('JWT_SECRET'), tokenOptions);
      return res.status(200).json({ 
        success: true, 
        token: token, 
        full_name: user.full_name,
        account_number: account.account_number,
        balance: Number(account.balance),
        role,
        account_status: user.account_status || account.status || 'ACTIVE'
      });
    } else {
      if (user && ['admin', 'reviewer'].includes(String(user.role || '').toLowerCase())) await db.collection('audit_events').insertOne({ _id: createId('AUDIT'), event_type: 'ADMIN_LOGIN_FAILED', user_id: user._id, actor_id: user._id, actor_role: String(user.role).toLowerCase(), outcome: 'REJECTED', delivery_status: 'RECORDED', attempts: 0, created_at: new Date(), updated_at: new Date() }).catch(() => {});
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Login is temporarily unavailable.' });
  }
};
