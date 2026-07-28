module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { role, ipInfo, userAgent } = req.body;
    
    // ==========================================
    // PUT YOUR TELEGRAM BOT CREDENTIALS HERE
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458:AAF6BG9j-hTC7N7NUE5e-IBICdDhsrJVm_M";
    const TELEGRAM_CHAT_ID = "8923655458";
    // ==========================================

    const messageText = `🚨 *SecurePay Test Alert*\n\n` +
                        `🏷️ *Node:* \`${role}\`\n` +
                        `🌐 *IP:* \`${ipInfo}\`\n` +
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
      return res.status(500).json({ telegramError: result.description });
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
