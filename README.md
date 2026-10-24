# Bulk Messenger

A web app with two features:

1. **Bulk email** - upload a contact list, write a message, send it through your own SMTP account.
2. **Bulk WhatsApp** - link your WhatsApp by QR code, upload a contact list, send a message.

```
backend/    Express + MongoDB + Redis (BullMQ queues) + Baileys + Nodemailer
frontend/   React + Vite + Tailwind
```

> **WhatsApp warning.** The WhatsApp feature uses Baileys, which is not an official WhatsApp
> integration. WhatsApp can ban numbers that message people who didn't ask to hear from them.
> Only message contacts who have agreed to it. The Meta WhatsApp Business Cloud API is the safe alternative.

## Run it locally

You need Node 20+ and Docker (for MongoDB and Redis).

```bash
# 1. databases
docker compose up -d

# 2. backend
cd backend
cp .env.example .env            # then set JWT_SECRET and ENCRYPTION_KEY
npm install express@5 cors helmet express-rate-limit mongoose bullmq ioredis \
  @whiskeysockets/baileys pino qrcode multer csv-parse exceljs libphonenumber-js \
  jsonwebtoken bcryptjs dotenv nodemailer sanitize-html
npm run dev                     # http://localhost:4000

# 3. frontend (new terminal)
cd frontend
cp .env.example .env
npm install react react-dom react-router-dom
npm install -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite
npm run dev                     # http://localhost:5173
```

Open http://localhost:5173, create an account, and:

- **Email:** Email -> Set up email (enter your SMTP details, press "Send test email") -> New campaign.
- **WhatsApp:** WhatsApp -> Connect WhatsApp (scan the QR in Linked devices) -> New campaign.

To test email without a real provider, run [Mailpit](https://github.com/axllent/mailpit) and set
`ALLOW_PRIVATE_SMTP=true` in `backend/.env`, then use host `localhost`, port `1025`.

## Contact files

`.csv`, `.xlsx` or `.json`, with a name column and a phone column (WhatsApp) or email column (email).
Each campaign screen has a "Download a sample file" link. Message templates support `{{name}}`;
WhatsApp messages also support `{Hi|Hello|Hey}` to vary the wording.

## How email sending works

- Each user saves their own SMTP settings. The password is encrypted (AES-256-GCM) with `ENCRYPTION_KEY`.
  Optionally you can set a platform-wide SMTP (`SMTP_*` in `.env`) as a fallback.
- Every email gets an unsubscribe link in the footer and `List-Unsubscribe` headers. Unsubscribed addresses
  are skipped in all later campaigns. **`PUBLIC_URL` must be reachable by recipients** (use your public API URL in production).
- Emails are queued and sent a few seconds apart. The HTML option is sanitized (no scripts, forms or images).

## API

All routes except auth and `/unsubscribe` need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | `{email, password}` -> `{token}` |
| GET | `/api/dashboard` | connection state, usage in the last 24h, recent campaigns |
| POST | `/api/whatsapp/connect` | start a session, returns status + QR |
| GET | `/api/whatsapp/status` | poll every ~2s while `status === "qr"` |
| POST | `/api/whatsapp/disconnect` | log out and delete the saved session |
| POST/GET | `/api/whatsapp/campaigns` | create (multipart: `file`, `name`, `message`, `consentConfirmed`, `appendOptOut`) / list |
| GET | `/api/whatsapp/campaigns/:id` | progress + per-recipient status |
| POST | `/api/whatsapp/campaigns/:id/pause` `/resume` `/cancel` | control a campaign |
| GET/PUT | `/api/email/settings` | read / save SMTP settings (password is never returned) |
| POST | `/api/email/settings/test` | verify the login and send a test email to your account address |
| POST/GET | `/api/email/campaigns` | create (multipart: `file`, `name`, `subject`, `body`, `bodyFormat`, `consentConfirmed`) / list |
| GET | `/api/email/campaigns/:id` | progress + per-recipient status |
| POST | `/api/email/campaigns/:id/pause` `/resume` `/cancel` | control a campaign |
| GET/POST | `/unsubscribe/:token` | public unsubscribe page (GET shows a button, POST unsubscribes) |

## Safety behaviour built in

Both channels: contact files are validated and de-duplicated, users must confirm they have permission to
contact the list, there is a daily cap per account, campaigns pause after 3 failures in a row, and
opt-outs are honored.

| | WhatsApp | Email |
|---|---|---|
| Max contacts per upload | 100 | 500 |
| Daily cap per account | 100 | 500 |
| Gap between sends | 30-90 s random | 2-6 s random |
| Opt-out | incoming "STOP" reply | unsubscribe link |
| Other | number checked with `onWhatsApp()`, typing indicator | SMTP host must be public (blocks SSRF) |

All limits are in `backend/.env`.

## Before you put this on the internet

- Set strong `JWT_SECRET` and `ENCRYPTION_KEY`, serve everything over https, and set `NODE_ENV=production`.
- Encrypt `backend/.wa-sessions/` at rest (anyone with those files can act as the linked WhatsApp account).
- Run one backend instance, or add sticky routing: each Baileys session must live in exactly one process.
- Email deliverability needs a real sending domain with SPF, DKIM and DMARC set up at your provider.
- Handle bounces and spam complaints (webhooks from SES/Brevo) before sending large volumes.
- Newer WhatsApp versions sometimes use `@lid` identifiers in incoming messages, so STOP matching by
  phone number may miss some replies. Test with real replies.
- Add tests, and pin dependency versions after your first install.
