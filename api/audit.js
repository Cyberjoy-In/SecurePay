module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Ensure body is parsed safely whether Vercel passes object or string
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    
    const { role, ipInfo, userAgent } = body || {};

    // ==========================================
    // ⚠️ CHECK THIS: DID YOU REPLACE THESE WITH REAL VALUES?
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458";
    const TELEGRAM_CHAT_ID = "8923655458:AAF6BG9j-hTC7N7NUE5e-IBICdDhsrJVm_M";
    // ==========================================

    const messageText = `🚨 *SecurePay Test Alert*\n\n` +
                        `🏷️ *Node:* \`${role || 'Unknown'}\`\n` +
                        `🌐 *IP:* \`${ipInfo || 'Unknown'}\`\n` +
                        `⏱️ *Time:* \`${new Date().toUTCString()}\``;

    const telegramResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: 'Markdown'
      })
    });

    const result = await telegramResponse.json();
    
    if (!result.ok) {
      console.error("Telegram Error Details:", result);
      return res.status(500).json({ telegramError: result.description, code: result.error_code });
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    console.error("Server Crash Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
};
