const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getRequiredEnv } = require('./_config');
const { getDatabase } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body;

  try {
    const db = await getDatabase();
    const user = await db.collection('users').findOne({ email });
    const account = user && await db.collection('accounts').findOne({ user_id: user._id });

    if (user && account && await bcrypt.compare(password, user.password_hash)) {
      const token = jwt.sign({ user_id: user._id }, getRequiredEnv('JWT_SECRET'), { expiresIn: '1h' });
      return res.status(200).json({ 
        success: true, 
        token: token, 
        full_name: user.full_name,
        account_number: account.account_number,
        balance: Number(account.balance)
      });
    } else {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Login failed: ' + error.message });
  }
};
