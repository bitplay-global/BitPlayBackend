/**
 * Ticket reply provider order: Gmail first, Brevo as fallback.
 * Uses fake providers; sends no mail. Run: node tests/ticket-reply-email.test.mjs
 */
import { sendTicketReply, defaultProviders } from '../helpers/ticketReplyEmail.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const fake = (name, { configured = true, fails = null } = {}) => {
  const p = { name, calls: [], isConfigured: () => configured,
    send: async o => { p.calls.push(o); if (fails) throw new Error(fails); return { ok: true, via: name }; } };
  return p;
};
const opts = { toEmail: 'user@example.com', toName: 'User', message: 'Hello', ticketPreview: 'Original' };
const quiet = async fn => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

console.log('order and fallback');
{
  const g = fake('Gmail'), b = fake('Brevo');
  const r = await sendTicketReply(opts, [g, b]);
  check('Gmail used when it works', r.provider === 'Gmail' && !r.fellBack);
  check('Brevo not called when Gmail works', b.calls.length === 0);
  check('the same arguments reach the provider', JSON.stringify(g.calls[0]) === JSON.stringify(opts));
}
{
  const g = fake('Gmail', { fails: 'Invalid login' }), b = fake('Brevo');
  const r = await quiet(() => sendTicketReply(opts, [g, b]));
  check('Brevo used when Gmail fails', r.provider === 'Brevo' && r.fellBack);
  check('Gmail was tried first', g.calls.length === 1 && b.calls.length === 1);
}
{
  const g = fake('Gmail', { configured: false }), b = fake('Brevo');
  const r = await sendTicketReply(opts, [g, b]);
  check('Brevo used when Gmail is not configured', r.provider === 'Brevo' && !r.fellBack);
  check('unconfigured Gmail is not called', g.calls.length === 0);
}

console.log('failures');
{
  const g = fake('Gmail', { fails: 'Invalid login' }), b = fake('Brevo', { fails: 'Key not found' });
  let err; try { await quiet(() => sendTicketReply(opts, [g, b])); } catch (e) { err = e; }
  check('both failing throws', !!err);
  check('error names both providers and reasons', /Gmail: Invalid login/.test(err?.message) && /Brevo: Key not found/.test(err?.message), err?.message);
  check('not flagged as unconfigured', err?.notConfigured === false);
}
{
  const g = fake('Gmail', { fails: 'Invalid login' }), b = fake('Brevo', { configured: false });
  let err; try { await quiet(() => sendTicketReply(opts, [g, b])); } catch (e) { err = e; }
  check('Gmail failing with Brevo unconfigured reports the Gmail reason', /Gmail: Invalid login/.test(err?.message) && !/Brevo/.test(err?.message), err?.message);
}
{
  let err; try { await sendTicketReply(opts, [fake('Gmail', { configured: false }), fake('Brevo', { configured: false })]); } catch (e) { err = e; }
  check('nothing configured is flagged as unconfigured', err?.notConfigured === true && /not configured/.test(err?.message), err?.message);
}

console.log('real providers');
check('defaults are Gmail then Brevo', defaultProviders.map(p => p.name).join(',') === 'Gmail,Brevo');
check('default providers expose isConfigured and send', defaultProviders.every(p => typeof p.isConfigured === 'function' && typeof p.send === 'function'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
