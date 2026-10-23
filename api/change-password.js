const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
    const payload = jwt.verify(token, getRequiredEnv('JWT_SECRET'));
    const db = await getDatabase();
    const users = db.collection('users');
    const user = await users.findOne({ _id: payload.user_id });

    if (!user || !await bcrypt.compare(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    if (await bcrypt.compare(new_password, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from your current password.' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await users.updateOne(
      { _id: user._id },
      { $set: { password_hash, password_updated_at: new Date() } }
    );

    return res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    return res.status(500).json({ error: 'Unable to update password right now.' });
  }
};
