const bcrypt = require('bcrypt');
const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');
const { createId } = require('./_ids');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { full_name, email, password } = req.body;

  // Strict Backend Validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\W).{6,}$/;

  if (!full_name || full_name.trim().length < 3) return res.status(400).json({ error: 'Full legal name is required.' });
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address format.' });
  if (!passRegex.test(password)) return res.status(400).json({ error: 'Password must be at least 6 characters and include uppercase, lowercase, and a special symbol.' });

  try {
    const db = await getDatabase();
    const users = db.collection('users');
    const accounts = db.collection('accounts');
    if (await users.findOne({ email })) return res.status(400).json({ error: 'This email address is already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = createId('USR');
    const accountNumber = 'ACCT-' + Math.floor(Math.random() * 1000000000); 

    await users.insertOne({ _id: userId, full_name, email, password_hash: hashedPassword });
    await accounts.insertOne({ _id: createId('ACCT'), user_id: userId, account_number: accountNumber, balance: 10000 });

    return res.status(200).json({ success: true, message: 'Account created successfully!' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
