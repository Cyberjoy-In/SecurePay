const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sender_email, receiver_account_number, amount } = req.body;
  const transferAmount = parseFloat(amount);

  // We use 'client' instead of 'pool' here to lock the database during the transfer
  const client = await pool.connect();

  try {
    // Start the secure transaction lock
    await client.query('BEGIN');

    // 1. Check Sender Account & Balance
    const senderRes = await client.query(`
      SELECT a.account_id, a.balance 
      FROM accounts a
      JOIN users u ON a.user_id = u.user_id
      WHERE u.email = $1
    `, [sender_email]);

    const sender = senderRes.rows[0];
    if (!sender) throw new Error("Sender account not found.");
    if (parseFloat(sender.balance) < transferAmount) throw new Error("Insufficient account balance.");

    // 2. Check Receiver Account (Must exist in your database)
    const receiverRes = await client.query(`
      SELECT account_id FROM accounts WHERE account_number = $1
    `, [receiver_account_number]);

    const receiver = receiverRes.rows[0];
    if (!receiver) throw new Error("Receiver account number not registered on SecurePay.");

    // 3. Deduct from Sender
    await client.query(`
      UPDATE accounts SET balance = balance - $1 WHERE account_id = $2
    `, [transferAmount, sender.account_id]);

    // 4. Credit to Receiver
    await client.query(`
      UPDATE accounts SET balance = balance + $1 WHERE account_id = $2
    `, [transferAmount, receiver.account_id]);

    // 5. Insert into Transactions table to create the receipt
    const txnRes = await client.query(`
      INSERT INTO transactions (sender_account_id, receiver_account_id, amount, status)
      VALUES ($1, $2, $3, 'COMPLETED')
      RETURNING transaction_id
    `, [sender.account_id, receiver.account_id, transferAmount]);

    const transactionId = txnRes.rows[0].transaction_id;

    // Save all changes permanently and unlock the database
    await client.query('COMMIT');

    // Send back the success receipt and the updated balance
    return res.status(200).json({ 
      success: true, 
      transaction_id: transactionId, 
      new_balance: parseFloat(sender.balance) - transferAmount 
    });

  } catch (error) {
    // If ANYTHING goes wrong, cancel the whole transfer instantly
    await client.query('ROLLBACK');
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    // Always release the database connection back to the pool
    client.release();
  }
};
