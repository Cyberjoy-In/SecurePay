const bcrypt = require('bcrypt');
const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');
const { getClient } = require('./_db');
const { createId } = require('./_ids');
const crypto = require('crypto');
const { allowRequest } = require('./_rate-limit');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowRequest(req, 'register', 6)) return res.status(429).json({ error: 'Too many registration attempts. Try again shortly.' });

  const { full_name: rawName, email, password } = req.body || {};
  const full_name = String(rawName || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Strict Backend Validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\W).{6,}$/;

  if (full_name.length < 3 || full_name.length > 120) return res.status(400).json({ error: 'Full legal name is required.' });
  if (!emailRegex.test(normalizedEmail)) return res.status(400).json({ error: 'Invalid email address format.' });
  if (!passRegex.test(password)) return res.status(400).json({ error: 'Password must be at least 6 characters and include uppercase, lowercase, and a special symbol.' });

  try {
    const db = await getDatabase();
    const users = db.collection('users');
    const accounts = db.collection('accounts');
    await Promise.all([
      users.createIndex({ email: 1 }, { unique: true }),
      accounts.createIndex({ account_number: 1 }, { unique: true }),
      accounts.createIndex({ user_id: 1 }, { unique: true })
    ]);
    if (await users.findOne({ email: normalizedEmail })) return res.status(400).json({ error: 'This email address is already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = createId('USR');
    const accountNumber = 'ACCT-' + crypto.randomInt(100000000, 1000000000);
    const client = await getClient();
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await users.insertOne({ _id: userId, full_name, email: normalizedEmail, password_hash: hashedPassword, token_version: 0, role: 'customer', account_status: 'ACTIVE', created_at: new Date() }, { session });
        await accounts.insertOne({ _id: createId('ACCT'), user_id: userId, account_number: accountNumber, balance: 10000, status: 'ACTIVE' }, { session });
      });
    } finally { await session.endSession(); }

    return res.status(200).json({ success: true, message: 'Account created successfully!' });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'This email or account is already registered.' });
    return res.status(500).json({ error: 'Registration is temporarily unavailable.' });
  }
};
