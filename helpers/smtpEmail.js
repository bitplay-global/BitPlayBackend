import nodemailer from "nodemailer";

/**
 * Plain SMTP email sending via nodemailer -- an alternative to Brevo's
 * transactional API for cases that don't need its deliverability/analytics
 * tooling (e.g. a single ticket acknowledgment). Same call shape as
 * helpers/brevoEmail.js's sendTicketReplyEmail so call sites can swap
 * between the two without other changes.
 *
 * Env:
 *   SMTP_HOST    – defaults to smtp.gmail.com
 *   SMTP_PORT    – defaults to 587
 *   SMTP_SECURE  – "true" for port 465 (implicit TLS); defaults to false (STARTTLS on 587)
 *   SMTP_USER    – mailbox to send from (required)
 *   SMTP_PASS    – app password / SMTP password (required)
 *   SMTP_FROM_NAME – display name (optional, default "BitPlayPro Support")
 */

function normalizeEnvString(value) {
  if (value == null) return "";
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function getSmtpUser() {
  return normalizeEnvString(process.env.SMTP_USER);
}

function getSmtpPass() {
  // App passwords are sometimes copy-pasted with spaces (Google shows them
  // as four 4-char groups) -- strip those, same class of paste mistake the
  // Brevo key sanitizer guards against.
  return normalizeEnvString(process.env.SMTP_PASS).replace(/\s+/g, "");
}

export function isSmtpConfigured() {
  return Boolean(getSmtpUser() && getSmtpPass());
}

let cachedTransporter = null;
let cachedTransporterKey = "";

function getTransporter() {
  const user = getSmtpUser();
  const pass = getSmtpPass();
  const host = normalizeEnvString(process.env.SMTP_HOST) || "smtp.gmail.com";
  const port = parseInt(normalizeEnvString(process.env.SMTP_PORT), 10) || 587;
  const secure = normalizeEnvString(process.env.SMTP_SECURE).toLowerCase() === "true";

  const key = `${host}:${port}:${secure}:${user}:${pass}`;
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

/** Call Brevo's account-check equivalent: just verify the SMTP connection/auth. */
export async function verifySmtpConnection() {
  if (!isSmtpConfigured()) {
    return { ok: false, message: "SMTP_USER / SMTP_PASS are not set." };
  }
  try {
    await getTransporter().verify();
    return { ok: true, user: getSmtpUser() };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

function escapeHtml(text) {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Same shape as brevoEmail.js's sendTicketReplyEmail.
 * @param {object} opts
 * @param {string} opts.toEmail
 * @param {string} [opts.toName]
 * @param {string} opts.message – plain text body
 * @param {string} [opts.ticketPreview] – original ticket message snippet, quoted below the body
 * @param {string} [opts.subject]
 */
export async function sendTicketReplyEmail({ toEmail, toName, message, ticketPreview, subject }) {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP is not configured. Set SMTP_USER and SMTP_PASS, then restart.");
  }

  const fromName = normalizeEnvString(process.env.SMTP_FROM_NAME) || "BitPlayPro Support";
  const finalSubject = subject || "Re: Your message to BitPlayPro Support";

  const textParts = [toName ? `Hi ${toName},` : "Hi,", "", message.trim()];
  if (ticketPreview) {
    textParts.push("", "---", "Your original message:", ticketPreview.trim());
  }

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

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${getSmtpUser()}>`,
    to: toName ? `"${toName}" <${toEmail.trim()}>` : toEmail.trim(),
    subject: finalSubject,
    text: textParts.join("\n"),
    html: htmlContent,
  });

  return { messageId: info.messageId, ok: true };
}
