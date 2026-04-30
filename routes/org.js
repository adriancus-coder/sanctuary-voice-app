function registerOrgRoutes(app, ctx) {
  const {
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION,
    COMMERCIAL_MODE,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    OPENAI_TRANSCRIBE_MODEL,
    QRCode,
    WEB_PUSH_ENABLED,
    WEB_PUSH_PUBLIC_KEY,
    buildBaseUrl,
    buildOrganizationStatus,
    buildPublicOrganization,
    db,
    dbStore,
    getActiveSpeechProvider,
    getDefaultOrganization,
    isEventActive,
    logger,
    packageJson,
    participantPresence,
    removePushSubscription,
    saveDb,
    storePushSubscription
  } = ctx;

  app.get('/api/health', (req, res) => {
    const organization = getDefaultOrganization();
    const activeEvents = Object.values(db.events || {}).filter((event) => isEventActive(event));
    const connectedParticipants = Array.from(participantPresence.values())
      .reduce((sum, presence) => sum + presence.size, 0);
    const disk = dbStore.getDiskInfo();
    res.json({
      ok: true,
      version: packageJson.version || '0.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      openaiConfigured: !!OPENAI_API_KEY,
      openai: {
        configured: !!OPENAI_API_KEY,
        status: OPENAI_API_KEY ? 'configured' : 'missing_key'
      },
      model: OPENAI_MODEL,
      transcribeModel: OPENAI_TRANSCRIBE_MODEL,
      speechProvider: getActiveSpeechProvider(),
      azureSpeechConfigured: !!(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION),
      activeEvents: activeEvents.length,
      connectedParticipants,
      disk,
      webPushEnabled: WEB_PUSH_ENABLED,
      commercialMode: COMMERCIAL_MODE,
      publicBaseUrl: buildBaseUrl(req),
      organization: buildPublicOrganization(organization)
    });
  });

  app.get('/api/languages', (req, res) => {
    res.json({ ok: true, languages: ctx.LANGUAGE_NAMES_RO });
  });

  app.get('/api/organization', (req, res) => {
    res.json({ ok: true, ...buildOrganizationStatus(ctx.DEFAULT_ORG_ID) });
  });

  app.get('/api/participant-qr.png', async (req, res) => {
    try {
      const participantUrl = `${buildBaseUrl(req)}/participant`;
      const buffer = await QRCode.toBuffer(participantUrl, { type: 'png', margin: 2, width: 720 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      logger.error('participant qr error:', err);
      res.status(500).send('QR error');
    }
  });

  app.get('/api/push/public-key', (req, res) => {
    res.json({
      ok: WEB_PUSH_ENABLED,
      enabled: WEB_PUSH_ENABLED,
      publicKey: WEB_PUSH_ENABLED ? WEB_PUSH_PUBLIC_KEY : ''
    });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const event = db.events[String(req.body.eventId || '').trim()];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!WEB_PUSH_ENABLED) return res.status(503).json({ ok: false, error: 'Push notifications are not configured.' });
    const saved = storePushSubscription(event, req.body.subscription, {
      participantId: req.body.participantId,
      language: req.body.language
    });
    if (!saved) return res.status(400).json({ ok: false, error: 'Push subscription invalid.' });
    saveDb();
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const event = db.events[String(req.body.eventId || '').trim()];
    if (!event) return res.json({ ok: true });
    const endpoint = String(req.body.endpoint || req.body.subscription?.endpoint || '').trim();
    if (removePushSubscription(event, endpoint)) saveDb();
    res.json({ ok: true });
  });
}

module.exports = {
  registerOrgRoutes
};
