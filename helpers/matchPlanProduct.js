/**
 * Returns the plan's store identifier that the reported product belongs to, or
 * null. Plans store Google subscriptions as "sku:basePlan", but a Google
 * purchase itself only carries the sku, so on Android the app reports the bare
 * sku. An exact-match check refused every such purchase after it was paid for.
 *
 * A bare sku matches the plan's "sku:basePlan"; the caller then verifies with
 * the plan's full identifier, so the base plan is still enforced. A reported
 * "sku:basePlan" matches a plan pinned to that base plan, or a plan stored as
 * the bare sku (which pins none, so verification accepts any base plan of it,
 * exactly as it does for a bare-sku report). Stray whitespace in the stored
 * identifiers (one plan has a leading space) is ignored.
 */
export function matchPlanProduct(plan, reported) {
  const claimed = String(reported ?? '').trim();
  if (!claimed) return null;
  const ids = [plan?.apple_identifier, plan?.google_identifier]
    .map(id => String(id ?? '').trim())
    .filter(Boolean);
  if (ids.includes(claimed)) return claimed;
  if (claimed.includes(':')) {
    const sku = claimed.split(':')[0];
    return ids.find(id => !id.includes(':') && id === sku) ?? null;
  }
  return ids.find(id => id.includes(':') && id.split(':')[0] === claimed) ?? null;
}
