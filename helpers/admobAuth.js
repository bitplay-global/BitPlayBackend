/**
 * AdMob OAuth: tokens stored in AppSettings. Uses client_id + client_secret from env
 * and refresh_token from DB. Refreshes access token when expired (no user re-auth unless refresh fails).
 */
import AppSettings from "../models/AppSettings.js";
import axios from "axios";

const ADMOB_TOKENS_KEY = "admob_oauth_tokens";
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 1 min before expiry

function getOAuthCreds() {
  const clientId = process.env.ADMOB_CLIENT_ID;
  const clientSecret = process.env.ADMOB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Load stored AdMob OAuth tokens from DB.
 * @returns {Promise<{ access_token?: string, refresh_token: string, expiry_date?: number } | null>}
 */
export async function loadAdMobTokens() {
  try {
    const doc = await AppSettings.findOne({ key: ADMOB_TOKENS_KEY }).lean();
    if (!doc?.value || typeof doc.value !== "object") return null;
    const { refresh_token, access_token, expiry_date } = doc.value;
    if (!refresh_token) return null;
    return {
      refresh_token: String(refresh_token),
      access_token: access_token ? String(access_token) : undefined,
      expiry_date: typeof expiry_date === "number" ? expiry_date : undefined,
    };
  } catch (err) {
    console.error("AdMob: Failed to load tokens from DB:", err?.message ?? err);
    return null;
  }
}

/**
 * Save AdMob OAuth tokens to DB (used after OAuth callback or after refresh).
 */
export async function saveAdMobTokens(tokens) {
  try {
    await AppSettings.findOneAndUpdate(
      { key: ADMOB_TOKENS_KEY },
      { $set: { value: tokens } },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("AdMob: Failed to save tokens:", err?.message ?? err);
    throw err;
  }
}

/**
 * Get a valid access token: use cached if still valid, else refresh using refresh_token.
 * Env: ADMOB_CLIENT_ID, ADMOB_CLIENT_SECRET. Tokens from DB (set via Settings or OAuth flow).
 * @returns {Promise<string | null>} access_token or null if not configured or refresh failed
 */
export async function getValidAccessToken() {
  const creds = getOAuthCreds();
  if (!creds) {
    console.warn("AdMob: ADMOB_CLIENT_ID / ADMOB_CLIENT_SECRET not set");
    return null;
  }

  const tokens = await loadAdMobTokens();
  if (!tokens?.refresh_token) {
    console.warn("AdMob: No tokens in settings. Connect AdMob in Admin → Settings.");
    return null;
  }

  const now = Date.now();
  if (
    tokens.access_token &&
    tokens.expiry_date &&
    now < tokens.expiry_date - TOKEN_REFRESH_BUFFER_MS
  ) {
    return tokens.access_token;
  }

  // Refresh
  try {
    const { data } = await axios.post(
      "https://oauth2.googleapis.com/token",
      {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      },
      { timeout: 15000 }
    );

    const updated = {
      ...tokens,
      access_token: data.access_token,
      expiry_date: now + (data.expires_in || 3600) * 1000,
    };
    await saveAdMobTokens(updated);
    return updated.access_token;
  } catch (err) {
    const msg = err.response?.data?.error_description ?? err.response?.data ?? err.message;
    console.error("AdMob: Token refresh failed:", msg);
    return null;
  }
}

/**
 * Check if AdMob is configured (creds + refresh token).
 */
export async function isAdMobConfigured() {
  const creds = getOAuthCreds();
  if (!creds) return false;
  const tokens = await loadAdMobTokens();
  return !!(tokens?.refresh_token);
}
