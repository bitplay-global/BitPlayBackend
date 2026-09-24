import AppSettings from "../models/AppSettings.js";

const KEY_VERSION_POLICY = "appVersionPolicy";

const DEFAULT_POLICY = {
  enabled: false,
  mode: "optional",
  latestVersion: "",
  minSupportedVersion: "",
  forceUpdateBelowVersion: "",
  title: "Update available",
  message: "A new version is available. Please update for the best experience.",
  buttonText: "Update now",
  dismissible: true,
  android: {
    mode: "optional",
    latestVersion: "",
    minSupportedVersion: "",
    forceUpdateBelowVersion: "",
    storeUrl: "",
    dismissible: true,
  },
  ios: {
    mode: "optional",
    latestVersion: "",
    minSupportedVersion: "",
    forceUpdateBelowVersion: "",
    storeUrl: "",
    dismissible: true,
  },
};

const VALID_MODES = new Set(["none", "optional", "force"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "on" || value === "1";
  return fallback;
}

function cleanMode(value, fallback = "optional") {
  const mode = cleanString(value).toLowerCase();
  return VALID_MODES.has(mode) ? mode : fallback;
}

function cleanPlatformConfig(input = {}, defaults = {}) {
  return {
    mode: cleanMode(input.mode, defaults.mode || "optional"),
    latestVersion: cleanString(input.latestVersion ?? defaults.latestVersion),
    minSupportedVersion: cleanString(input.minSupportedVersion ?? defaults.minSupportedVersion),
    forceUpdateBelowVersion: cleanString(
      input.forceUpdateBelowVersion ?? defaults.forceUpdateBelowVersion
    ),
    storeUrl: cleanString(input.storeUrl ?? defaults.storeUrl),
    dismissible: cleanBoolean(input.dismissible, defaults.dismissible ?? true),
  };
}

function sanitizePolicy(input = {}, fallback = DEFAULT_POLICY) {
  const android = cleanPlatformConfig(input.android, fallback.android);
  const ios = cleanPlatformConfig(input.ios, fallback.ios);

  return {
    enabled: cleanBoolean(input.enabled, fallback.enabled),
    mode: cleanMode(input.mode, fallback.mode),
    latestVersion: cleanString(input.latestVersion ?? fallback.latestVersion),
    minSupportedVersion: cleanString(input.minSupportedVersion ?? fallback.minSupportedVersion),
    forceUpdateBelowVersion: cleanString(
      input.forceUpdateBelowVersion ?? fallback.forceUpdateBelowVersion
    ),
    title: cleanString(input.title ?? fallback.title),
    message: cleanString(input.message ?? fallback.message),
    buttonText: cleanString(input.buttonText ?? fallback.buttonText),
    dismissible: cleanBoolean(input.dismissible, fallback.dismissible),
    android,
    ios,
  };
}

export async function getVersionPolicy() {
  try {
    const doc = await AppSettings.findOne({ key: KEY_VERSION_POLICY }).lean();
    if (!doc?.value || typeof doc.value !== "object") {
      return { ...DEFAULT_POLICY };
    }
    return sanitizePolicy(doc.value, DEFAULT_POLICY);
  } catch (err) {
    console.error("Error reading app version policy from DB:", err);
    return { ...DEFAULT_POLICY };
  }
}

export async function setVersionPolicy(policyInput) {
  const previous = await getVersionPolicy();
  const policy = sanitizePolicy(policyInput, previous);
  await AppSettings.findOneAndUpdate(
    { key: KEY_VERSION_POLICY },
    { $set: { value: policy } },
    { upsert: true, new: true }
  );
  return policy;
}

