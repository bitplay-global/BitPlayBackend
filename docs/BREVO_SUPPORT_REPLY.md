# Brevo – admin support ticket replies

When an admin replies from **Support Tickets** (`/admin/help`), the app sends the message with the [Brevo Transactional Email API](https://developers.brevo.com/reference/sendtransacemail).

## Environment variables

Add to `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `BREVO_API_KEY` | Yes | API key from Brevo → SMTP & API |
| `BREVO_SENDER_EMAIL` | Yes | Sender address (must be verified in Brevo) |
| `BREVO_SENDER_NAME` | No | Display name (default: `Support`) |
| `BREVO_REPLY_TO` | No | If set, “Reply-To” header so user replies go to this inbox |
| `APP_NAME` or `BREVO_APP_NAME` | No | Used in subject: `Re: Your message to {name}` |

## Brevo setup

1. Create a [Brevo](https://www.brevo.com) account.
2. Verify your sender domain or single sender email.
3. Create an API key with permission to send transactional emails.
4. Paste `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` into `.env` and restart the server.

## Security

`POST /api/help/reply` requires an **admin session** (`isLoggedIn`). The help page must be used while logged into the admin panel so the session cookie is sent (`credentials: 'same-origin'`).

## “Key not found” when sending a reply

Brevo returns **Key not found** when the `api-key` header is wrong. Common causes:

1. **Wrong or placeholder key** – Use a real key from Brevo → **Settings** → **SMTP & API** → **API keys** (create one with permission to send emails).
2. **Typo or extra characters** – No spaces at the start/end of `BREVO_API_KEY` in `.env`. Do not wrap the key in quotes unless your tooling requires it; the app strips matching outer quotes if present.
3. **Server not restarted** after editing `.env`.
4. **SMTP password used instead of API key** – The transactional API needs the **API key** (`xkeysib-…`), not the SMTP password alone.

5. **Authorized IPs** – Brevo → **Security** → **Authorized IPs**. If this is enabled, requests from your server’s public IP are rejected unless whitelisted (sometimes reported as key/auth errors).

## Test from admin UI

On **Support Tickets** (`/admin/help`), use **Test Brevo connection**. It calls Brevo `GET /v3/account` with the same key as send; if that fails, the key or network/IP rules are wrong before you try a reply.

## If you ever shared your API key publicly

Revoke it in Brevo → API keys → delete, create a new key, update `.env`, restart.
