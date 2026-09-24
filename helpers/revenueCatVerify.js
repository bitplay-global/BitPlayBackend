/**
 * Server-to-store verification for in-app purchases.
 *
 * Until this existed, POST /api/privileges/:userId granted a +5000%/+10000% ad
 * multiplier on the client's word alone: no authentication, no receipt check.
 * A patched app -- or a plain curl -- produced a "purchase" with any price the
 * caller felt like, which is why privileges appear in the database that have no
 * matching payment in RevenueCat.
 *
 * The client's own check was never a control either. In SuperPrivilegesScreen
 * the app inspects customerInfo after purchaseStoreProduct() and posts if it
 * looks successful, but that runs on the attacker's device.
 *
 * RevenueCat is the only party here that knows whether money actually moved.
 *
 * Sandbox purchases are refused in production. A Play Console licence tester, or
 * anyone on an internal testing track, completes a purchase without being
 * charged: the transaction is real, the entitlement is real, and no money
 * arrives. RevenueCat records these but excludes them from revenue -- which is
 * exactly the shape of "the privilege was granted but nothing was paid".
 */

const RC_API = 'https://api.revenuecat.com/v1/subscribers';
const TIMEOUT_MS = 10_000;

export class PurchaseVerificationError extends Error {
  constructor(message, code, status = 402) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Confirms `appUserId` really bought `productIdentifier`, according to RevenueCat.
 *
 * @returns {Promise<{transactionId: string, purchasedAt: Date, store: string}>}
 * @throws {PurchaseVerificationError} when it cannot be confirmed -- fails closed.
 */
async function fetchSubscriber(appUserId, productIdentifier) {
  const secret = process.env.REVENUECAT_SECRET_KEY;
  if (!secret) {
    // Deliberately fails closed. An unset key must not silently reopen the hole
    // this function exists to close.
    throw new PurchaseVerificationError(
      'Purchase verification is not configured on the server.',
      'VERIFICATION_UNCONFIGURED',
      503,
    );
  }
  if (!appUserId || !productIdentifier) {
    throw new PurchaseVerificationError(
      'Purchase could not be verified.',
      'VERIFICATION_MISSING_FIELDS',
      400,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let payload;
  try {
    const res = await fetch(`${RC_API}/${encodeURIComponent(appUserId)}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
    });
    if (res.status === 404) {
      throw new PurchaseVerificationError(
        'No purchase found for this account.',
        'VERIFICATION_NO_SUBSCRIBER',
      );
    }
    if (!res.ok) {
      // Log what RevenueCat actually said. Collapsing every failure into one
      // opaque code made a rejected API key look identical to an outage.
      const detail = await res.text().catch(() => '');
      console.error(
        `[Purchase verification] RevenueCat returned ${res.status}: ${detail.slice(0, 300)}`,
      );
      // 401/403 is a server misconfiguration, not something a retry fixes. The
      // usual cause is a public SDK key (goog_/appl_) where the V1 secret key
      // (sk_) is required, or a key belonging to a different project.
      if (res.status === 401 || res.status === 403) {
        throw new PurchaseVerificationError(
          'Purchase verification is misconfigured on the server.',
          'VERIFICATION_BAD_CREDENTIALS',
          503,
        );
      }
      throw new PurchaseVerificationError(
        'Could not verify the purchase right now. Please try again.',
        'VERIFICATION_UPSTREAM_ERROR',
        502,
      );
    }
    payload = await res.json();
  } catch (err) {
    if (err instanceof PurchaseVerificationError) throw err;
    throw new PurchaseVerificationError(
      'Could not verify the purchase right now. Please try again.',
      'VERIFICATION_UNREACHABLE',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  return payload?.subscriber;
}

export async function verifyNonSubscriptionPurchase({ appUserId, productIdentifier }) {
  const subscriber = await fetchSubscriber(appUserId, productIdentifier);
  const payload = { subscriber };

  // Consumables land in non_subscriptions, keyed by product id.
  const purchases = payload?.subscriber?.non_subscriptions?.[productIdentifier];
  if (!Array.isArray(purchases) || purchases.length === 0) {
    throw new PurchaseVerificationError(
      'No purchase of this item was found on your account.',
      'VERIFICATION_NO_PURCHASE',
    );
  }

  const latest = purchases[purchases.length - 1];

  // A test purchase must not grant a paid privilege in production. Set
  // ALLOW_SANDBOX_PURCHASES=true in staging if you need to exercise the flow.
  const sandboxAllowed = process.env.ALLOW_SANDBOX_PURCHASES === 'true';
  if (latest.is_sandbox === true && !sandboxAllowed) {
    throw new PurchaseVerificationError(
      'This purchase was made in a test environment and cannot be applied.',
      'VERIFICATION_SANDBOX_PURCHASE',
    );
  }

  const transactionId = latest.store_transaction_id || latest.id;
  if (!transactionId) {
    throw new PurchaseVerificationError(
      'Purchase could not be verified.',
      'VERIFICATION_NO_TRANSACTION_ID',
    );
  }

  return {
    transactionId: String(transactionId),
    purchasedAt: latest.purchase_date ? new Date(latest.purchase_date) : new Date(),
    store: latest.store || 'unknown',
    isSandbox: latest.is_sandbox === true,
  };
}

/**
 * Like verifyNonSubscriptionPurchase, for products that may be subscriptions.
 *
 * Mining plans are billed per period, so RevenueCat can record them under
 * `subscriptions` rather than `non_subscriptions`; both are searched. Google
 * subscription ids appear either whole ("sku:base-plan") or split into the key
 * "sku" plus product_plan_identifier "base-plan", so both spellings match.
 *
 * Refunded and (in production) sandbox transactions are refused.
 *
 * @returns {Promise<{transactionId: string, purchasedAt: Date, store: string, kind: 'subscription'|'non_subscription'}>}
 */
export async function verifyStorePurchase({ appUserId, productIdentifier }) {
  const subscriber = await fetchSubscriber(appUserId, productIdentifier);

  const [sku, basePlan] = String(productIdentifier).split(':');
  const candidates = [];

  const nonSubs = subscriber?.non_subscriptions || {};
  for (const key of [productIdentifier, sku]) {
    for (const t of Array.isArray(nonSubs[key]) ? nonSubs[key] : []) candidates.push({ ...t, kind: 'non_subscription' });
  }
  const subs = subscriber?.subscriptions || {};
  for (const [key, t] of Object.entries(subs)) {
    const whole = key === productIdentifier;
    const split = key === sku && (!basePlan || !t.product_plan_identifier || t.product_plan_identifier === basePlan);
    if (whole || split) candidates.push({ ...t, kind: 'subscription' });
  }

  if (candidates.length === 0) {
    throw new PurchaseVerificationError('No purchase of this item was found on your account.', 'VERIFICATION_NO_PURCHASE');
  }

  // Most recent purchase of this product.
  candidates.sort((a, b) => new Date(b.purchase_date || 0) - new Date(a.purchase_date || 0));
  const latest = candidates[0];

  if (latest.refunded_at) {
    throw new PurchaseVerificationError('This purchase was refunded.', 'VERIFICATION_REFUNDED');
  }
  if (latest.is_sandbox === true && process.env.ALLOW_SANDBOX_PURCHASES !== 'true') {
    throw new PurchaseVerificationError('This purchase was made in a test environment and cannot be applied.', 'VERIFICATION_SANDBOX_PURCHASE');
  }

  const transactionId = latest.store_transaction_id || latest.id ||
    (latest.purchase_date ? `${productIdentifier}@${latest.purchase_date}` : null);
  if (!transactionId) {
    throw new PurchaseVerificationError('Purchase could not be verified.', 'VERIFICATION_NO_TRANSACTION_ID');
  }

  return {
    transactionId: String(transactionId),
    purchasedAt: latest.purchase_date ? new Date(latest.purchase_date) : new Date(),
    store: latest.store || 'unknown',
    kind: latest.kind,
  };
}

/**
 * The whole RevenueCat subscriber record, for tools that reconcile every
 * purchase on an account (scripts/recover-purchases.js). Same key, timeout and
 * errors as verification.
 */
export async function getSubscriber(appUserId) {
  return fetchSubscriber(appUserId, '*');
}
