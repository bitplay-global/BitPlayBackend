/**
 * Send an admin's reply to a support ticket.
 *
 * Gmail SMTP (helpers/smtpEmail.js) is tried first: it is the path the ticket
 * acknowledgements already use successfully. Brevo (helpers/brevoEmail.js) is
 * the fallback, used only when Gmail is not configured or its send fails.
 * Both helpers take the same arguments and produce the same email.
 *
 * Providers are injectable so the fallback order can be tested without
 * sending mail.
 */
import * as smtp from './smtpEmail.js';
import * as brevo from './brevoEmail.js';

export const defaultProviders = [
  { name: 'Gmail', isConfigured: smtp.isSmtpConfigured, send: smtp.sendTicketReplyEmail },
  { name: 'Brevo', isConfigured: brevo.isBrevoConfigured, send: brevo.sendTicketReplyEmail },
];

/**
 * @param {{toEmail: string, toName?: string, message: string, ticketPreview?: string}} opts
 * @param {Array<{name: string, isConfigured: () => boolean, send: (o: object) => Promise<any>}>} [providers]
 * @returns {Promise<{provider: string, fellBack: boolean, result: any}>}
 * @throws Error with `.notConfigured` (no provider configured) and `.attempts`
 */
export async function sendTicketReply(opts, providers = defaultProviders) {
  const attempts = [];
  for (const p of providers) {
    if (!p.isConfigured()) {
      attempts.push({ provider: p.name, error: 'not configured' });
      continue;
    }
    try {
      const result = await p.send(opts);
      return { provider: p.name, fellBack: attempts.some(a => a.error !== 'not configured'), result };
    } catch (err) {
      const msg = err?.message || String(err);
      attempts.push({ provider: p.name, error: msg });
      console.error(`Ticket reply via ${p.name} failed: ${msg}`);
    }
  }
  const tried = attempts.filter(a => a.error !== 'not configured');
  const error = new Error(tried.length
    ? `Could not send the reply. ${tried.map(a => `${a.provider}: ${a.error}`).join(' | ')}`
    : 'Email is not configured. Set SMTP_USER and SMTP_PASS (Gmail), or BREVO_API_KEY and BREVO_SENDER_EMAIL (Brevo), then restart.');
  error.notConfigured = tried.length === 0;
  error.attempts = attempts;
  throw error;
}
