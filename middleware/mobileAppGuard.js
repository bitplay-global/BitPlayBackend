const DEFAULT_ALLOWED_APP_IDS = ['bitplay-mobile'];

const getAllowedAppIds = () => {
  const raw = process.env.MOBILE_ALLOWED_APP_IDS;
  if (!raw) return DEFAULT_ALLOWED_APP_IDS;
  return raw
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
};

export const mobileAppGuard = (req, res, next) => {
  const enforceInProdOnly = process.env.MOBILE_GUARD_PROD_ONLY !== 'false';
  const isProduction = process.env.NODE_ENV === 'production';
  const shouldEnforce = enforceInProdOnly ? isProduction : true;

  if (!shouldEnforce) {
    return next();
  }

  const appId = String(req.headers['x-app-id'] || '').trim().toLowerCase();
  const platform = String(req.headers['x-app-platform'] || '').trim().toLowerCase();
  const appVersion = String(req.headers['x-app-version'] || '').trim();
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  const mobileClient = String(req.headers['x-mobile-client'] || '').trim().toLowerCase();

  const allowedAppIds = getAllowedAppIds();
  const validPlatform = platform === 'android' || platform === 'ios';
  const validAppId = allowedAppIds.includes(appId);
  const validDeviceId = deviceId.length >= 8;
  const validVersion = appVersion.length > 0;
  const validMobileClient = mobileClient === 'true';

  if (!validAppId || !validPlatform || !validVersion || !validDeviceId || !validMobileClient) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: mobile app access required.',
      code: 'MOBILE_APP_REQUIRED',
    });
  }

  return next();
};
