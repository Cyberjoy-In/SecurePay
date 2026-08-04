const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  // Only accept data that is being sent to us
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body;

  try {
    // 1. Search the database for the user's email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // 2. If the user exists, check if the password matches our shredded version
    if (user && await bcrypt.compare(password, user.password_hash)) {
      
      // 3. Create a temporary digital ID card (token) for this user
      const token = jwt.sign(
        { user_id: user.user_id }, 
        process.env.JWT_SECRET || 'securepay_demo_key', 
        { expiresIn: '1h' } // The ID card expires in 1 hour for safety
      );
      
      // Give them the ID card and let them in
      return res.status(200).json({ success: true, token: token, message: 'Login successful!' });
    } else {
      // If the email or password is wrong, block them
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Login failed due to a server error.' });
  }
};
