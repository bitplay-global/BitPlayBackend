import SibApiV3Sdk from "sib-api-v3-sdk";

/**
 * Brevo (formerly Sendinblue) API via official SDK
 * https://www.npmjs.com/package/sib-api-v3-sdk
 *
 * Env:
 *   BREVO_API_KEY      – API key from Brevo (SMTP & API)
 *   BREVO_SENDER_EMAIL – Verified sender in Brevo
 *   BREVO_SENDER_NAME  – Display name (optional, default "Support")
 *   BREVO_REPLY_TO     – Optional; where user replies go (support inbox)
 */

/** Trim and strip accidental wrapping quotes from .env paste mistakes */
function normalizeEnvString(value) {
  if (value == null) return "";
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Brevo keys are a single token (xkeysib-…). Any whitespace, line breaks, BOM,
 * or “fancy” hyphens from editors will make Brevo return "Key not found".
 */
function sanitizeBrevoApiKey(raw) {
  let s = normalizeEnvString(raw);
  if (!s) return "";
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  s = s.replace(/\s+/g, "");
  s = s.replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, "-");
  return s;
}

function getBrevoApiKey() {
  return sanitizeBrevoApiKey(process.env.BREVO_API_KEY);
}

function getBrevoSenderEmail() {
  return normalizeEnvString(process.env.BREVO_SENDER_EMAIL);
}

function humanizeBrevoError(status, apiMessage) {
  const msg = String(apiMessage || "").toLowerCase();
  if (msg.includes("key not found") || status === 401) {
    return (
      "Brevo: Key not found — usually the key string reaching the server is wrong, not the dashboard. " +
      "Check: (1) Key from SMTP & API → API Keys (not SMTP password). (2) One line in .env, no line break in the middle of the key. " +
      "(3) Brevo → Security → Authorized IPs: turn OFF restriction or add this server’s IP. " +
      "(4) Regenerate key, paste immediately, restart Node. " +
      "(5) Ensure no second BREVO_API_KEY and no shell env overriding .env."
    );
  }
  if (msg.includes("unauthorized") || msg.includes("invalid api key")) {
    return "Brevo API key is invalid or expired. Generate a new key in Brevo and update BREVO_API_KEY, then restart.";
  }
  return apiMessage || `Brevo API error (HTTP ${status})`;
}

function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isBrevoConfigured() {
  const key = getBrevoApiKey();
  const sender = getBrevoSenderEmail();
  return Boolean(key && sender && key.length >= 8);
}

const BREVO_ACCOUNT_URL = "https://api.brevo.com/v3/account";

function getBrevoClient() {
  const apiKey = getBrevoApiKey();
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const auth = defaultClient.authentications["api-key"];
  auth.apiKey = apiKey;
  return { apiKey, defaultClient };
}

/**
 * Call Brevo GET /account with the same key as send — use to debug "Key not found".
 * Does not expose the key.
 */
export async function verifyBrevoApiKey() {
  const apiKey = getBrevoApiKey();
  if (!apiKey) {
    return { ok: false, brevoMessage: "BREVO_API_KEY is empty after sanitizing (.env / env vars)." };
  }
  try {
    getBrevoClient();
    const accountApi = new SibApiV3Sdk.AccountApi();
    const data = await accountApi.getAccount();
    return {
      ok: true,
      brevoAccountEmail: data?.email,
      companyName: data?.companyName,
      keyLength: apiKey.length,
    };
  } catch (err) {
    const status = err?.status || err?.response?.statusCode || 500;
    const rawMsg =
      err?.response?.body?.message ||
      err?.response?.text ||
      err?.message ||
      `HTTP ${status}`;
    return {
      ok: false,
      status,
      brevoMessage: humanizeBrevoError(status, rawMsg),
      keyLength: apiKey.length,
    };
  }
}

/**
 * Send admin reply to a support ticket holder via Brevo.
 * @param {object} opts
 * @param {string} opts.toEmail
 * @param {string} [opts.toName]
 * @param {string} opts.message – plain text body (admin reply)
 * @param {string} [opts.ticketPreview] – original ticket message snippet
 * @param {string} [opts.subject] – email subject
 */
export async function sendTicketReplyEmail({
  toEmail,
  toName,
  message,
  ticketPreview,
  subject,
}) {
  if (!isBrevoConfigured()) {
    throw new Error(
      "Brevo is not configured. Set BREVO_API_KEY (full xkeysib-… key from Brevo) and BREVO_SENDER_EMAIL (verified sender), then restart."
    );
  }

  const { apiKey } = getBrevoClient();
  const senderEmail = getBrevoSenderEmail();
  const senderName = normalizeEnvString(process.env.BREVO_SENDER_NAME) || "Support";
  const replyToEmail = process.env.BREVO_REPLY_TO ? normalizeEnvString(process.env.BREVO_REPLY_TO) : "";

  const appName = process.env.APP_NAME || process.env.BREVO_APP_NAME || "Support";
  const finalSubject =
    subject || `Re: Your message to ${appName}`;

  const textParts = [];
  if (toName) textParts.push(`Hi ${toName},`);
  else textParts.push("Hi,");
  textParts.push("");
  textParts.push(message.trim());
  if (ticketPreview) {
    textParts.push("");
    textParts.push("---");
    textParts.push("Your original message:");
    textParts.push(ticketPreview.trim());
  }
  const textContent = textParts.join("\n");

  const htmlContent = `
    <div style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
      ${toName ? `<p>Hi ${escapeHtml(toName)},</p>` : "<p>Hi,</p>"}
      <p style="white-space: pre-wrap;">${escapeHtml(message)}</p>
      ${
        ticketPreview
          ? `<hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
             <p style="color: #666; font-size: 13px;">Your original message:</p>
             <blockquote style="border-left: 3px solid #ccc; padding-left: 12px; color: #444; white-space: pre-wrap;">${escapeHtml(ticketPreview)}</blockquote>`
          : ""
      }
    </div>
  `.trim();

  const body = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: toEmail.trim(), ...(toName ? { name: toName.trim() } : {}) }],
    subject: finalSubject,
    textContent,
    htmlContent,
  };

  if (replyToEmail) {
    body.replyTo = { email: replyToEmail, name: senderName };
  }

  let data;
  try {
    const transactionalApi = new SibApiV3Sdk.TransactionalEmailsApi();
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.sender = body.sender;
    sendSmtpEmail.to = body.to;
    sendSmtpEmail.subject = body.subject;
    sendSmtpEmail.textContent = body.textContent;
    sendSmtpEmail.htmlContent = body.htmlContent;
    if (body.replyTo) sendSmtpEmail.replyTo = body.replyTo;
    data = await transactionalApi.sendTransacEmail(sendSmtpEmail);
  } catch (err) {
    const status = err?.status || err?.response?.statusCode || 500;
    const rawMsg =
      err?.response?.body?.message ||
      err?.response?.text ||
      err?.message ||
      "";
    throw new Error(humanizeBrevoError(status, rawMsg));
  }

  return { messageId: data?.messageId, ok: true, keyLength: apiKey.length };
}
