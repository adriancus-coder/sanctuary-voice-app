function registerAdminRoutes(app, ctx) {
  const {
    COMMERCIAL_MODE,
    buildAdminAppUrl,
    clearAdminSessionCookie,
    isAdminLoginConfigured,
    isAllowedAdminPin,
    renderAdminLoginPage,
    sanitizeLocalNextPath,
    setAdminSessionCookie,
    shouldRedirectAdminTrafficToApp
  } = ctx;

  app.post('/api/admin-login', (req, res) => {
    const pin = String(req.body.pin || req.body.code || '').trim();
    const nextPath = sanitizeLocalNextPath(req.body.next || req.query.next || '/admin');
    if (shouldRedirectAdminTrafficToApp(req)) {
      return res.redirect(307, buildAdminAppUrl(`/api/admin-login?next=${encodeURIComponent(nextPath)}`));
    }
    if (!isAdminLoginConfigured()) {
      return res.status(500).send(renderAdminLoginPage({
        error: 'Admin PIN is not configured. Add MASTER_ADMIN_PIN in Render Environment first.',
        nextPath
      }));
    }
    if (!isAllowedAdminPin(pin)) {
      return res.status(403).send(renderAdminLoginPage({ error: 'Invalid admin PIN.', nextPath }));
    }
    setAdminSessionCookie(req, res);
    return res.redirect(nextPath);
  });

  app.post('/api/admin-logout', (req, res) => {
    clearAdminSessionCookie(req, res);
    res.json({ ok: true, commercialMode: COMMERCIAL_MODE });
  });
}

module.exports = {
  registerAdminRoutes
};
