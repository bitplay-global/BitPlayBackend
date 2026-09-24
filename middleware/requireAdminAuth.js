export function requireAdminAuth(req, res, next) {
  if (req.session?.isLoggedIn) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Unauthorized" });
}
