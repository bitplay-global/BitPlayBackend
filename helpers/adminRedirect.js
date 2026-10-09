/**
 * Where to send an admin after logging in. Only paths inside the admin panel
 * are accepted, so the `next` parameter cannot be used to redirect someone to
 * another site (open redirect) or back to the login/logout pages.
 */
const DEFAULT = '/admin/dashboard';
const ALLOWED = /^\/admin\/[A-Za-z0-9_\-./]*(\?[A-Za-z0-9_\-.~=&%+]*)?$/;

export function safeAdminNext(next) {
  if (typeof next !== 'string' || next.length > 300) return DEFAULT;
  if (!ALLOWED.test(next)) return DEFAULT;
  if (next.includes('//') || next.includes('..') || next.includes('\\')) return DEFAULT;
  if (/^\/admin\/(login|logout)(\/|\?|$)/.test(next)) return DEFAULT;
  return next;
}

export const ADMIN_HOME = DEFAULT;
