# Secure-Pay

## Payments with security built into every step.

**Secure-Pay** is a modern Node.js payment dashboard designed to help teams manage account transfers, verify high-risk transactions, and maintain a clear, auditable transaction history.

When a payment requires additional scrutiny, Secure-Pay activates a step-up verification workflow designed to add another layer of protection before the transaction proceeds.

**Secure your payments. Verify with confidence. Keep your operations informed.**

## Security that steps up when risk rises

Not every transaction needs the same level of verification.

Secure-Pay can flag higher-risk payment activity and initiate a controlled verification sequence before sensitive operations continue.

### High-risk verification workflow

**1. Transaction flagged**

A potentially high-risk payment is identified for additional verification.

↓

**2. Biometric consent**

The user is clearly informed and must provide consent before biometric capture is initiated.

↓

**3. Out-of-band verification**

A token-pair exchange between the sender and receiver provides an additional verification signal outside the primary transaction flow.

↓

**4. Server-side security gateway**

The verification event is processed through the server-side audit gateway, keeping sensitive operational credentials away from the browser.

↓

**5. Security operations dispatch**

Configured audit information can be forwarded to the designated security operations channel for review and response.

## Your credentials stay server-side

Sensitive infrastructure credentials should never live in your frontend.

Secure-Pay's audit gateway is designed so that environment secrets, including database credentials, JWT signing secrets, and Telegram bot credentials, are accessed exclusively by the server.

The browser does **not** receive:

- Database connection credentials
- JWT signing secrets
- Telegram bot tokens
- Server-side environment variables
- Other private infrastructure credentials

This separation helps reduce the risk of accidentally exposing operational secrets through client-side code, browser storage, or public configuration.

## One dashboard. Complete transaction visibility.

Keep payment activity organized with a dashboard built around the information your team needs.

### Account transfers

Manage account-to-account payment activity through a centralized interface.

### Step-up verification

Apply additional verification when transaction risk requires stronger controls.

### Transaction history

Review previous activity and maintain a clear record of payment events.

### Security auditing

Route authorized audit events through a server-side gateway for operational review.

### Session protection

Authenticated sessions use time-limited JWTs, with successful sessions configured to expire after seven days.

## Built for secure deployments

Secure-Pay separates application configuration from source code and browser-accessible assets.

For local development, configuration is supplied through environment variables. For production deployments, the same variables can be configured through your hosting provider's protected environment settings.

**Never place secrets in:**

- `index.html`
- Browser local storage
- Public environment variables
- Committed source code
- Screenshots, logs, or other publicly accessible artifacts

If a secret is ever exposed, it should be revoked and replaced immediately.

## Security operations, without exposing your infrastructure

When configured by your organization, Secure-Pay can deliver security-audit events to a designated operations channel.

The audit gateway can include contextual information such as:

- Transaction security events
- IP-derived location information
- User-agent information
- A camera snapshot captured after explicit user consent

This information is intended for authorized security operations and should be handled according to your organization's privacy, retention, and access-control policies.

## Privacy and consent come first

Security controls should never operate behind the user's back.

Before biometric or camera-based verification is performed, users should be clearly informed about what is being collected, why it is required, and where the resulting information may be transmitted.

Organizations deploying Secure-Pay are responsible for ensuring that biometric processing, camera capture, IP-derived location data, transaction information, and operational disclosures comply with applicable laws and internal policies.

**Security should strengthen trust - not compromise it.**

## Ready for safer payment operations?

Bring transaction management, step-up verification, auditability, and security operations together in one dashboard.

**Secure-Pay - verify the risk, protect the transaction.**

## Technical deployment note

For local development, install dependencies and start the development server:

```bash
npm install
npm run dev
```

Secure-Pay can then be accessed locally at:

```text
http://localhost:3000
```

Production deployments should configure all required environment variables through the hosting platform's protected environment settings. Never commit real credentials to source control.

**Required configuration includes:**

`MONGODB_URI` - `MONGODB_DB_NAME` - `JWT_SECRET` - `TELEGRAM_BOT_TOKEN` - `TELEGRAM_CHAT_ID` - `FINNHUB_API_KEY`

If a Telegram credential or other secret is exposed in a repository, deployment log, screenshot, or chat, revoke it immediately and replace it across every affected environment.
