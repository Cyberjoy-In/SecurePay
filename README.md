# Secure-Pay

Secure-Pay is a Node.js payment dashboard with account transfers, step-up verification, transaction history, and a server-side security-audit delivery path.

## Security audit flow

High-risk payment verification follows this sequence:

```text
[ High-Risk Transaction Flagged ]
              |
              v
[ Mandatory Biometric Consent & Capture ]
              |
              v
[ Out-of-Band Token Pair Exchange (Sender <-> Receiver) ]
              |
              v
[ Serverless Node Gateway (/api/audit.js) ]
              |
              +--> Captures IP geolocation and user-agent
              +--> Renders a live camera canvas snapshot after consent
              |
              v
[ Instant Security Operations Center Dispatch (Telegram Bot) ]
```

The browser never receives the Telegram token, database URI, JWT secret, or other environment credentials. `api/audit.js` reads those values only on the server.

## Environment configuration

1. Copy `.env.example` to `.env` for local development.
2. Replace every placeholder with a real value. Generate a long random `JWT_SECRET`.
3. Configure the same variables in Vercel under **Settings -> Environment Variables** before deployment.
4. Do not put credentials into `index.html`, browser storage, or public environment variables.

Required variables:

- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `JWT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `FINNHUB_API_KEY`

`.env` is ignored by Git. Only `.env.example`, which contains placeholders, should be committed.

If a Telegram token is exposed in a repository, deployment log, screenshot, or chat, revoke it with BotFather and replace it in every environment before deployment.

## Local development

```bash
npm install
npm run dev
```

The application is available at `http://localhost:3000`.

## Session behavior

Successful logins receive a JWT with a seven-day expiry. The dashboard restores a valid local session after refresh and returns to the sign-in page after expiry or explicit sign-out.

## Privacy note

The audit route can transmit a consented camera snapshot and contextual transaction data to the configured operations chat. Make sure users are informed and that this processing is appropriate for your jurisdiction and policy requirements.
