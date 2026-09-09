const { Pool } = require('pg');
const { getRequiredEnv } = require('./_config');
const pool = new Pool({ connectionString: getRequiredEnv('POSTGRES_URL') });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sender_email, receiver_account_number, amount } = req.body;
  const transferAmount = parseFloat(amount);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const senderRes = await client.query(`SELECT a.account_id, a.balance FROM accounts a JOIN users u ON a.user_id = u.user_id WHERE u.email = $1`, [sender_email]);
    const sender = senderRes.rows[0];
    if (!sender) throw new Error("Sender account not found.");
    if (parseFloat(sender.balance) < transferAmount) throw new Error("Insufficient account balance.");

    const receiverRes = await client.query(`SELECT account_id FROM accounts WHERE account_number = $1`, [receiver_account_number]);
    const receiver = receiverRes.rows[0];
    if (!receiver) throw new Error("Receiver account not registered.");

    // Check if these two users have EVER completed a successful transaction before to establish automatic trust
    const trustCheck = await client.query(`
      SELECT 1 FROM transactions 
      WHERE ((sender_account_id = $1 AND receiver_account_id = $2) OR (sender_account_id = $2 AND receiver_account_id = $1)) 
      AND status = 'COMPLETED' LIMIT 1
    `, [sender.account_id, receiver.account_id]);
    
    const isTrusted = trustCheck.rows.length > 0;
    const txnStatus = isTrusted ? 'PENDING_TRUSTED' : 'PENDING';

    await client.query(`UPDATE accounts SET balance = balance - $1 WHERE account_id = $2`, [transferAmount, sender.account_id]);
    await client.query(`UPDATE accounts SET balance = balance + $1 WHERE account_id = $2`, [transferAmount, receiver.account_id]);

    const txnRes = await client.query(`
      INSERT INTO transactions (sender_account_id, receiver_account_id, amount, status)
      VALUES ($1, $2, $3, $4) RETURNING transaction_id
    `, [sender.account_id, receiver.account_id, transferAmount, txnStatus]);

    await client.query('COMMIT');
    
    return res.status(200).json({ 
      success: true, 
      transaction_id: txnRes.rows[0].transaction_id, 
      new_balance: parseFloat(sender.balance) - transferAmount,
      is_trusted: isTrusted 
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
};
