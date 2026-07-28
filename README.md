# SecurePay Enterprise Core 🛡️
### Risk-Based Step-Up Authentication & Anti-Fraud Transaction Firewall

![Vercel Deployment](https://img.shields.io/badge/Deployment-Vercel%20Serverless-black?style=flat-square&logo=vercel)
![Node.js](https://img.shields.io/badge/Backend-Node.js%20CommonJS-green?style=flat-square&logo=nodedotjs)
![Security](https://img.shields.io/badge/Compliance-RBI%20%2F%20MFA%20Standard-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)

---

## 📋 Overview

**SecurePay** is an enterprise-grade, risk-based step-up authentication and anti-fraud firewall engineered to combat rapid-layering attacks, automated botnet transfers, and "money mule" networks in digital payment ecosystems. 

Traditional static credentials and text OTPs are vulnerable to modern man-in-the-middle and automated scraping scripts. SecurePay introduces a dynamic **out-of-band human verification handshake** that temporarily pauses high-risk transactions, requiring both transacting parties to cryptographically validate tokens and complete compliance telemetry checks before settlement.

---

## ✨ Key Features

* **Velocity Risk Engine:** Real-time monitoring simulation that detects frequency anomalies and triggers immediate step-up verification challenges upon encountering smurfing signatures.
* **Out-of-Band Cryptographic Handshake:** Forces active coordination between sender and receiver via unique short-lived tokens and dynamic QR code generation to break automated bot execution loops.
* **Silent Compliance Audit Capture:** Automatically records user metadata (IP address, location, ISP, and browser user-agent) alongside a live webcam biometric verification snapshot at the exact moment of transaction clearance.
* **Serverless Security Gateway:** Relays real-time incident reports, metadata, and visual evidence securely through a serverless backend directly to an operations monitoring channel (Telegram Bot API).

---

## 🏛️ System Architecture & Workflow

```text
 [ High-Risk Transaction Flagged ] 
                 │
                 ▼
 [ Mandatory Biometric Consent & Capture ]
                 │
                 ▼
 [ Out-of-Band Token Pair Exchange (Sender ↔ Receiver) ]
                 │
                 ▼
 [ Serverless Node Gateway (/api/audit.js) ]
                 │
                 ├──────► Captures IP Geolocation & User-Agent
                 ├──────► Renders Live Camera Canvas Snapshot
                 │
                 ▼
 [ Instant Security Operations Center Dispatch (Telegram Bot) ]
