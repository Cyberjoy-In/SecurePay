const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    
    const { image, role, ipInfo, userAgent, userEmail, amount } = body || {};

    const TELEGRAM_BOT_TOKEN = "8923655458:AAEiCNK4WqCj9sQVOY7z-ZYeBXsdWX00aPY";
    const TELEGRAM_CHAT_ID = "8783830673";

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const transferAmount = parseFloat(amount) || 0;
    
    // Generate a unique Transaction ID (e.g., TXN-9F83A2)
    const transactionId = 'TXN-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // 1. DYNAMIC BALANCE UPDATE IN DATABASE
    if (userEmail && transferAmount > 0) {
      const userRes = await pool.query('SELECT user_id FROM users WHERE email = $1', [userEmail]);
      if (userRes.rows.length > 0) {
        const userId = userRes.rows[0].user_id;

        if (role.startsWith('Sender')) {
          await pool.query('UPDATE accounts SET balance = balance - $1 WHERE user_id = $2', [transferAmount, userId]);
        } else if (role.startsWith('Receiver')) {
          await pool.query('UPDATE accounts SET balance = balance + $1 WHERE user_id = $2', [transferAmount, userId]);
        }
      }
    }

    // 2. SAVE TRANSACTION RECORD & ID TO DATABASE LOGS
    await pool.query(
      'INSERT INTO audit_logs (node_role, ip_address, photo_status) VALUES ($1, $2, $3)',
      [role, ipInfo, `${transactionId} - Cleared (₹${transferAmount})`]
    );

    // 3. SEND AUDIT SNAPSHOT, TRANSACTION ID & METADATA TO TELEGRAM
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', blob, 'audit.png');
    
    const captionText = `🚨 *SecurePay Compliance Audit*\n\n` +
                        `🆔 *Transaction ID:* \`${transactionId}\`\n` +
                        `🏷️ *Node Tag:* \`${role || 'Unknown'}\`\n` +
                        `💰 *Amount:* \`₹${transferAmount}\`\n` +
                        `🌐 *IP Address:* \`${ipInfo || 'Unknown'}\`\n` +
                        `💻 *Device:* \`${userAgent || 'Unknown'}\`\n` +
                        `⏱️ *Timestamp:* \`${new Date().toUTCString()}\`\n` +
                        `✅ *Status:* \`Handshake Cleared & Logged\``;
                        
    formData.append('caption', captionText);
    formData.append('parse_mode', 'Markdown');

    const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    const result = await telegramResponse.json();
    
    if (!result.ok) {
      console.error("🔴 TELEGRAM PHOTO ERROR:", JSON.stringify(result));
      return res.status(500).json({ telegramError: result.description });
    }

    return res.status(200).json({ success: true, transactionId, result });
  } catch (error) {
    console.error("🔴 SERVER CRASH:", error.message);
    return res.status(500).json({ error: error.message });
  }
};
