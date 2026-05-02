const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function registerEventRoutes(app, ctx) {
  const {
    AUDIO_ARCHIVE_ENABLED,
    SUMMARY_WEBHOOK_URL,
    SUMMARY_RECIPIENT,
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION,
    COMMERCIAL_MODE,
    DEFAULT_ORG_ID,
    LANGUAGES,
    LANGUAGE_NAMES_RO,
    TRANSCRIBE_RATE_LIMIT_MAX,
    TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
    appendAudioArchiveChunk,
    audioArchivePath,
    applyDisplaySnapshot,
    applySourceCorrections,
    buildBaseUrl,
    buildDisplayPayload,
    buildPublicOrganization,
    buildSongTranslations,
    buildTranslationsForAllTargets,
    client,
    cloneDisplaySnapshot,
    closeAzureSpeechSessionsForEvent,
    createEvent,
    db,
    defaultDisplayState,
    defaultSongState,
    emitTranscriptionState,
    emitUsageStats,
    ensureEventAccessLinks,
    ensureEventUiState,
    getActiveEventIdForOrg,
    getDisplayLanguageChoices,
    getEventOrgId,
    getOrganizationEvents,
    getOrganizationForEvent,
    getOrganizationMemory,
    getOrganizationPinnedTextLibrary,
    getOrganizationSongLibrary,
    getRemoteOperatorPermissions,
    getSourceCorrections,
    getSuppliedEventCode,
    getTranslationCacheSnapshot,
    hasValidAdminSession,
    io,
    isAdminLoginConfigured,
    logger,
    normalizeDisplayPreset,
    normalizeDisplayTextScale,
    normalizeEvent,
    normalizeEventForAccess,
    normalizeOrgId,
    normalizeRemoteOperatorProfile,
    normalizeRemoteOperators,
    participantPresence,
    processText,
    pushSongHistory,
    queueSpeechText,
    recordAudit,
    recordScreenAction,
    recordTranscribeLatency,
    recordTranscribeUsage,
    rememberDisplayState,
    requireAdminApiSession,
    requireEventAdmin,
    requireEventManager,
    requireEventPermission,
    requireEventRole,
    requireGlobalLibraryAdmin,
    resolveEventAccessFromCode,
    sanitizeStructuredText,
    sanitizeTranscriptText,
    saveDb,
    setActiveEventIdForOrg,
    setSongIndex,
    setTranscriptionPaused,
    speechBuffers,
    splitSongBlocksWithLabels,
    summarizeEvent,
    transcribeAudioFile,
    transcribeRateLimits,
    upload,
    upsertLibraryItem
  } = ctx;

  app.get('/api/events/:id/azure-token', async (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(500).json({ ok: false, error: 'Azure Speech nu este configurat.' });
    }
    try {
      const response = await fetch(`https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
          'Content-Length': '0'
        }
      });
      if (!response.ok) {
        return res.status(502).json({ ok: false, error: `Azure token failed: ${response.status}` });
      }
      res.json({ ok: true, token: await response.text(), region: AZURE_SPEECH_REGION });
    } catch (err) {
      logger.error('azure token error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'Nu am putut cere token Azure.' });
    }
  });

  app.post('/api/events', async (req, res) => {
    if (!requireEventManager(req, res)) return;
    try {
      const baseUrl = buildBaseUrl(req);
      const organizationId = normalizeOrgId(req.body.organizationId || DEFAULT_ORG_ID);
      const event = await createEvent({
        name: req.body.name,
        speed: req.body.speed,
        sourceLang: req.body.sourceLang || 'ro',
        targetLangs: req.body.targetLangs || ['no', 'en'],
        baseUrl,
        scheduledAt: req.body.scheduledAt || null,
        scheduledDate: req.body.scheduledDate || null,
        scheduledTime: req.body.scheduledTime || null,
        timezone: req.body.timezone || null,
        organizationId
      });
      res.json({ ok: true, event: normalizeEvent(event, { includeSecrets: true }) });
    } catch (err) {
      logger.error('create event error:', err);
      res.status(500).json({ ok: false, error: 'Nu am putut crea evenimentul.' });
    }
  });

  app.get('/api/events/active', (req, res) => {
    const activeEventId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
    const event = activeEventId ? db.events[activeEventId] : null;
    if (!event) return res.status(404).json({ ok: false, error: 'Nu există eveniment activ.' });
    ensureEventAccessLinks(event, buildBaseUrl(req));
    saveDb();
    res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO, organization: buildPublicOrganization(getOrganizationForEvent(event)) });
  });

  app.get('/api/events/upcoming', (req, res) => {
    const baseUrl = buildBaseUrl(req);
    const now = Date.now();
    const events = getOrganizationEvents(DEFAULT_ORG_ID)
      .filter((event) => !event.hidden)
      .filter((event) => typeof event.scheduledTimestamp === 'number' && event.scheduledTimestamp > now)
      .sort((a, b) => a.scheduledTimestamp - b.scheduledTimestamp)
      .map((event) => ({
        id: event.id,
        name: event.name || '',
        scheduledTimestamp: event.scheduledTimestamp,
        scheduledDate: event.scheduledDate || null,
        scheduledTime: event.scheduledTime || null,
        timezone: event.timezone || null,
        translateLink: event.translateLink || `${baseUrl}/translate?event=${event.id}`,
        participantLink: event.participantLink || `${baseUrl}/participant?event=${event.id}`
      }));
    res.json({ ok: true, events });
  });

  app.get('/api/stats/search', (req, res) => {
    if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const query = String(req.query?.q || '').trim();
    if (query.length < 2) return res.json({ ok: true, query, results: [] });
    const needle = query.toLowerCase();
    const results = [];
    const limitPerEvent = 20;
    const totalLimit = 200;
    const events = Object.values(db.events || {})
      .filter((event) => getEventOrgId(event) === DEFAULT_ORG_ID)
      .sort((a, b) => new Date(b.scheduledAt || b.createdAt || 0) - new Date(a.scheduledAt || a.createdAt || 0));
    for (const event of events) {
      if (results.length >= totalLimit) break;
      const transcripts = Array.isArray(event.transcripts) ? event.transcripts : [];
      let matchedInEvent = 0;
      for (let i = transcripts.length - 1; i >= 0 && matchedInEvent < limitPerEvent; i -= 1) {
        const entry = transcripts[i];
        const haystacks = [String(entry?.original || '')];
        const translations = entry?.translations || {};
        for (const v of Object.values(translations)) haystacks.push(String(v || ''));
        const hit = haystacks.find((h) => h.toLowerCase().includes(needle));
        if (hit) {
          results.push({
            eventId: event.id,
            eventShortId: event.shortId || null,
            eventName: event.name || 'Untitled event',
            eventDate: event.scheduledAt || event.createdAt || null,
            entryId: entry.id,
            createdAt: entry.createdAt || null,
            sourceLang: entry.sourceLang || event.sourceLang || 'ro',
            original: entry.original || '',
            translations
          });
          matchedInEvent += 1;
        }
      }
    }
    res.json({ ok: true, query, results });
  });

  app.get('/api/stats/overview', (req, res) => {
    if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const events = Object.values(db.events || {})
      .filter((event) => getEventOrgId(event) === DEFAULT_ORG_ID);
    let totalAudioSeconds = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let totalTranscripts = 0;
    let totalUniqueParticipants = 0;
    const list = events.map((event) => {
      const stats = event.usageStats || {};
      const audioSeconds = Number(stats.audioSeconds) || 0;
      const tokens = Number(stats.tokensTranslation) || 0;
      const cost = Number(stats.estimatedCostUSD) || 0;
      const transcripts = Array.isArray(event.transcripts) ? event.transcripts.length : (Number(stats.transcriptCount) || 0);
      const uniqueParticipants = Number(stats.uniqueParticipantsEver) || 0;
      totalAudioSeconds += audioSeconds;
      totalTokens += tokens;
      totalCost += cost;
      totalTranscripts += transcripts;
      totalUniqueParticipants += uniqueParticipants;
      return {
        id: event.id,
        shortId: event.shortId || null,
        name: event.name || 'Untitled event',
        scheduledAt: event.scheduledAt || null,
        scheduledTimestamp: typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null,
        createdAt: event.createdAt || null,
        sourceLang: event.sourceLang || 'ro',
        targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
        hidden: !!event.hidden,
        testMode: !!event.testMode,
        audioSeconds,
        tokensTranslation: tokens,
        estimatedCostUSD: cost,
        transcriptCount: transcripts,
        uniqueParticipantsEver: uniqueParticipants
      };
    }).sort((a, b) => {
      const at = a.scheduledTimestamp || new Date(a.scheduledAt || a.createdAt || 0).getTime();
      const bt = b.scheduledTimestamp || new Date(b.scheduledAt || b.createdAt || 0).getTime();
      return bt - at;
    });
    res.json({
      ok: true,
      totals: {
        events: events.length,
        uniqueParticipants: totalUniqueParticipants,
        audioSeconds: totalAudioSeconds,
        audioHours: Math.round((totalAudioSeconds / 3600) * 100) / 100,
        tokensTranslation: totalTokens,
        transcripts: totalTranscripts,
        estimatedCostUSD: Math.round(totalCost * 1e4) / 1e4
      },
      cache: typeof getTranslationCacheSnapshot === 'function' ? getTranslationCacheSnapshot() : null,
      events: list
    });
  });

  app.get('/api/events/:id/stats', (req, res) => {
    if (!hasValidAdminSession(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const event = db.events[req.params.id];
    if (!event || getEventOrgId(event) !== DEFAULT_ORG_ID) {
      return res.status(404).json({ ok: false, error: 'Event not found.' });
    }
    const stats = event.usageStats || {};
    const seenById = stats.seenParticipantIds && typeof stats.seenParticipantIds === 'object' ? stats.seenParticipantIds : {};
    const participantsByLanguage = {};
    Object.values(seenById).forEach((lang) => {
      const key = String(lang || 'unknown').trim() || 'unknown';
      participantsByLanguage[key] = (participantsByLanguage[key] || 0) + 1;
    });
    let archiveBytes = 0;
    let archiveExists = false;
    if (AUDIO_ARCHIVE_ENABLED && typeof audioArchivePath === 'function') {
      try {
        const p = audioArchivePath(event.id);
        if (fs.existsSync(p)) {
          archiveExists = true;
          archiveBytes = fs.statSync(p).size;
        }
      } catch (_) {}
    }
    res.json({
      ok: true,
      event: {
        id: event.id,
        shortId: event.shortId || null,
        name: event.name || 'Untitled event',
        scheduledAt: event.scheduledAt || null,
        scheduledTimestamp: typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null,
        createdAt: event.createdAt || null,
        sourceLang: event.sourceLang || 'ro',
        targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
        transcriptCount: Array.isArray(event.transcripts) ? event.transcripts.length : (Number(stats.transcriptCount) || 0)
      },
      usageStats: {
        ...stats,
        seenParticipantIds: undefined
      },
      participantsByLanguage,
      audioArchive: {
        enabled: !!AUDIO_ARCHIVE_ENABLED,
        exists: archiveExists,
        bytes: archiveBytes
      },
      summary: {
        webhookConfigured: !!SUMMARY_WEBHOOK_URL,
        recipient: SUMMARY_RECIPIENT || null
      },
      cost: {
        audioCostUSD: Math.round((Number(stats.audioSeconds) || 0) * (0.003 / 60) * 1e6) / 1e6,
        translationCostUSD: Math.round((Number(stats.tokensTranslation) || 0) * 0.0000004 * 1e6) / 1e6,
        totalUSD: Number(stats.estimatedCostUSD) || 0
      }
    });
  });

  app.get('/api/events/:id/audio-archive', (req, res) => {
    if (!hasValidAdminSession(req)) return res.status(401).send('Unauthorized');
    if (!AUDIO_ARCHIVE_ENABLED) return res.status(404).send('Audio archive disabled.');
    const event = db.events[req.params.id];
    if (!event || getEventOrgId(event) !== DEFAULT_ORG_ID) return res.status(404).send('Event not found.');
    const filePath = audioArchivePath(event.id);
    if (!fs.existsSync(filePath)) return res.status(404).send('No archive recorded yet for this event.');
    const filename = `recording-${event.shortId || event.id}.webm`;
    res.setHeader('Content-Type', 'video/webm');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/events/:id/transcript-export', (req, res) => {
    if (!hasValidAdminSession(req)) return res.status(401).send('Unauthorized');
    const event = db.events[req.params.id];
    if (!event || getEventOrgId(event) !== DEFAULT_ORG_ID) return res.status(404).send('Event not found.');
    const lines = (Array.isArray(event.transcripts) ? event.transcripts : [])
      .map((entry) => {
        const time = entry?.createdAt ? new Date(entry.createdAt).toISOString() : '';
        const head = `[${time}] (${entry?.sourceLang || event.sourceLang || 'ro'}) ${entry?.original || ''}`;
        const tx = Object.entries(entry?.translations || {})
          .map(([lang, text]) => `  ${lang.toUpperCase()}: ${text}`)
          .join('\n');
        return tx ? `${head}\n${tx}` : head;
      })
      .join('\n\n');
    const filename = `transcript-${event.shortId || event.id}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`${event.name || 'Event'}\n\n${lines}\n`);
  });

  app.get('/api/events/resolve/:value', (req, res) => {
    const raw = String(req.params.value || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Event ID required.' });
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const activeId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
    const found = Object.values(db.events || {}).find((event) => {
      if (!event || event.hidden) return false;
      if (event.id === raw) return true;
      if (String(event.shortId || '').toUpperCase() === normalized) return true;
      return false;
    });
    if (!found) return res.status(404).json({ ok: false, error: 'Event not found.' });
    res.json({
      ok: true,
      eventId: found.id,
      shortId: found.shortId || null,
      name: found.name || 'Service',
      isActive: activeId === found.id,
      testMode: !!found.testMode
    });
  });

  app.get('/api/events/public', (req, res) => {
    const activeEventId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
    const events = getOrganizationEvents(DEFAULT_ORG_ID)
      .filter((event) => !event.hidden)
      .sort((a, b) => {
        const left = new Date(a.scheduledAt || a.createdAt || 0);
        const right = new Date(b.scheduledAt || b.createdAt || 0);
        return right - left;
      })
      .map((event) => {
        ensureEventAccessLinks(event);
        return event;
      })
      .map((event) => ({
        id: event.id,
        shortId: event.shortId || null,
        name: event.name,
        scheduledAt: event.scheduledAt || null,
        scheduledDate: event.scheduledDate || null,
        scheduledTime: event.scheduledTime || null,
        timezone: event.timezone || null,
        scheduledTimestamp: typeof event.scheduledTimestamp === 'number' ? event.scheduledTimestamp : null,
        createdAt: event.createdAt || null,
        sourceLang: event.sourceLang || 'ro',
        targetLangs: Array.isArray(event.targetLangs) ? event.targetLangs : [],
        isActive: activeEventId === event.id,
        testMode: !!event.testMode
      }));
    res.json({ ok: true, events, activeEventId: activeEventId || null, languageNames: LANGUAGE_NAMES_RO, organization: buildPublicOrganization() });
  });

  app.get('/api/events', (req, res) => {
    if ((COMMERCIAL_MODE || isAdminLoginConfigured()) && !requireAdminApiSession(req, res)) return;
    const activeEventId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
    const events = getOrganizationEvents(DEFAULT_ORG_ID)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(summarizeEvent);
    res.json({ ok: true, events, activeEventId: activeEventId || null, languageNames: LANGUAGE_NAMES_RO, organization: buildPublicOrganization() });
  });

  app.get('/api/events/:id', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    ensureEventAccessLinks(event, buildBaseUrl(req));
    saveDb();
    const access = hasValidAdminSession(req)
      ? { role: 'admin', permissions: ['main_screen', 'song'], operator: null }
      : resolveEventAccessFromCode(event, getSuppliedEventCode(req));
    res.json({ ok: true, event: normalizeEvent(event, { includeSecrets: access.role === 'admin' }), languageNames: LANGUAGE_NAMES_RO, organization: buildPublicOrganization(getOrganizationForEvent(event)) });
  });

  app.post('/api/events/:id/remote-operators', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    ensureEventAccessLinks(event, buildBaseUrl(req));
    const name = String(req.body.name || '').trim();
    const profile = normalizeRemoteOperatorProfile(req.body.profile);
    if (!name) return res.status(400).json({ ok: false, error: 'Numele operatorului lipseste.' });
    const operator = {
      id: randomUUID(),
      name,
      profile,
      code: `SV-REMOTE-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      permissions: getRemoteOperatorPermissions(profile),
      remoteLink: ''
    };
    event.remoteOperators.unshift(operator);
    ensureEventAccessLinks(event, buildBaseUrl(req));
    saveDb();
    res.json({ ok: true, remoteOperators: event.remoteOperators });
  });

  app.delete('/api/events/:id/remote-operators/:operatorId', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    event.remoteOperators = normalizeRemoteOperators(event.remoteOperators || []).filter((item) => item.id !== req.params.operatorId);
    saveDb();
    res.json({ ok: true, remoteOperators: event.remoteOperators });
  });

  app.post('/api/events/:id/settings', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    if (typeof req.body.speed === 'string' && req.body.speed.trim()) event.speed = req.body.speed.trim();
    if (typeof req.body.sourceLang === 'string') {
      const sourceLang = req.body.sourceLang.trim();
      if (LANGUAGES[sourceLang]) {
        event.sourceLang = sourceLang;
        event.liveSourceLang = sourceLang;
        event.songState = event.songState || defaultSongState();
        event.displayState = event.displayState || defaultDisplayState();
        if (!event.songState?.sourceLang) event.songState.sourceLang = sourceLang;
        if (!event.displayState?.manualSourceLang) event.displayState.manualSourceLang = sourceLang;
      }
    }
    if (typeof req.body.liveSourceLang === 'string') {
      const liveSourceLang = req.body.liveSourceLang.trim();
      event.liveSourceLang = liveSourceLang === 'auto' || LANGUAGES[liveSourceLang] ? liveSourceLang : (event.liveSourceLang || 'auto');
    }
    saveDb();
    res.json({ ok: true, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/visibility', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin'])) return;
    const desired = typeof req.body?.hidden === 'boolean'
      ? !!req.body.hidden
      : !event.hidden;
    event.hidden = desired;
    if (typeof recordAudit === 'function') {
      recordAudit(getEventOrgId(event), desired ? 'event_hidden' : 'event_visible', { eventId: event.id, name: event.name });
    }
    saveDb();
    res.json({ ok: true, hidden: event.hidden, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/mode', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    const mode = String(req.body.mode || 'live').trim();
    if (!['live', 'song'].includes(mode)) return res.status(400).json({ ok: false, error: 'Mod invalid.' });
    if (mode === 'song' && !requireEventPermission(req, res, 'song')) return;
    if (mode === 'live' && req.eventRole !== 'admin') {
      const permissions = req.eventAccess?.permissions || [];
      if (!permissions.includes('song') && !permissions.includes('main_screen')) {
        return res.status(403).json({ ok: false, error: 'Operatorul nu are permisiunea pentru aceasta actiune.' });
      }
    }
    const scope = String(req.body.scope || 'all').trim();
    const participantOnly = scope === 'participant';
    ensureEventUiState(event);
    const previousMode = event.mode;
    event.mode = mode;
    if (previousMode !== mode) {
      speechBuffers.delete(event.id);
      event.lastTranscriptNorm = '';
    }
    if (mode === 'live' && !participantOnly) {
      rememberDisplayState(event);
      setTranscriptionPaused(event, false, { save: false, emit: false });
      event.displayState.mode = 'auto';
      event.displayState.blackScreen = false;
      event.displayState.sceneLabel = '';
      event.displayState.updatedAt = new Date().toISOString();
    }
    saveDb();
    io.to(`event:${event.id}`).emit('mode_changed', { mode });
    if (mode === 'live' && !participantOnly) {
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
      emitTranscriptionState(event);
    }
    res.json({ ok: true, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/activate', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    setActiveEventIdForOrg(getEventOrgId(event), event.id);
    if (typeof recordAudit === 'function') {
      recordAudit(getEventOrgId(event), 'event_set_live', { eventId: event.id, name: event.name });
    }
    saveDb();
    io.emit('active_event_changed', { eventId: event.id });
    res.json({ ok: true, event: normalizeEventForAccess(req, event) });
  });

  app.delete('/api/events/:id', (req, res) => {
    const event = db.events[req.params.id];
  if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
  if (!requireEventAdmin(req, res, event)) return;
  closeAzureSpeechSessionsForEvent?.(req.params.id);
  const eventName = event.name;
  const orgIdSnapshot = getEventOrgId(event);
  delete db.events[req.params.id];
  speechBuffers.delete(req.params.id);
    participantPresence.delete(req.params.id);
    const orgId = orgIdSnapshot;
    if (getActiveEventIdForOrg(orgId) === req.params.id) {
      const remaining = getOrganizationEvents(orgId).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      setActiveEventIdForOrg(orgId, remaining[0]?.id || null);
    }
    if (typeof recordAudit === 'function') {
      recordAudit(orgId, 'event_deleted', { eventId: req.params.id, name: eventName });
    }
    saveDb();
    io.emit('active_event_changed', { eventId: getActiveEventIdForOrg(orgId) || null });
    res.json({ ok: true, activeEventId: getActiveEventIdForOrg(orgId) || null });
  });

  app.post('/api/events/:id/duplicate', async (req, res) => {
    const source = db.events[req.params.id];
    if (!source) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, source)) return;
    try {
      const baseUrl = buildBaseUrl(req);
      const namePrefix = String(req.body?.name || '').trim();
      const duplicatedName = namePrefix || `${source.name || 'Service'} (copy)`;
      const newEvent = await createEvent({
        name: duplicatedName,
        speed: source.speed || 'balanced',
        sourceLang: source.sourceLang || 'ro',
        targetLangs: Array.isArray(source.targetLangs) ? [...source.targetLangs] : ['no', 'en'],
        baseUrl,
        scheduledDate: req.body?.scheduledDate || null,
        scheduledTime: req.body?.scheduledTime || null,
        timezone: req.body?.timezone || source.timezone || null,
        organizationId: getEventOrgId(source)
      });
      newEvent.glossary = JSON.parse(JSON.stringify(source.glossary || {}));
      newEvent.sourceCorrections = JSON.parse(JSON.stringify(source.sourceCorrections || {}));
      newEvent.songLibrary = Array.isArray(source.songLibrary)
        ? source.songLibrary.map((item) => ({ ...item, id: randomUUID() }))
        : [];
      if (typeof recordAudit === 'function') {
        recordAudit(getEventOrgId(newEvent), 'event_duplicated', {
          fromEventId: source.id,
          fromName: source.name,
          eventId: newEvent.id,
          name: newEvent.name
        });
      }
      saveDb();
      res.json({ ok: true, event: normalizeEvent(newEvent, { includeSecrets: true }) });
    } catch (err) {
      logger.error('duplicate event error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'Could not duplicate event.' });
    }
  });

  app.post('/api/events/:id/target-langs', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const requested = Array.isArray(req.body?.targetLangs) ? req.body.targetLangs : [];
    const cleaned = Array.from(new Set(
      requested
        .map((l) => String(l || '').trim().toLowerCase())
        .filter((l) => LANGUAGES[l])
    ));
    if (!cleaned.length) return res.status(400).json({ ok: false, error: 'At least one target language is required.' });
    if (cleaned.includes(String(event.sourceLang || 'ro').toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'Source language cannot also be a target.' });
    }
    event.targetLangs = cleaned;
    ensureEventUiState(event);
    if (!cleaned.includes(event.displayState.language)) {
      event.displayState.language = cleaned[0];
    }
    if (event.displayState.secondaryLanguage && !cleaned.includes(event.displayState.secondaryLanguage)) {
      event.displayState.secondaryLanguage = '';
    }
    saveDb();
    io.to(`event:${event.id}`).emit('event_target_langs_changed', {
      eventId: event.id,
      targetLangs: event.targetLangs,
      displayLanguage: event.displayState.language,
      secondaryLanguage: event.displayState.secondaryLanguage || ''
    });
    res.json({ ok: true, targetLangs: event.targetLangs, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/transcripts/clear', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const transcriptCount = Array.isArray(event.transcripts) ? event.transcripts.length : 0;
    event.transcripts = [];
    event.lastTranscriptNorm = '';
    event.latestDisplayEntry = null;
    if (typeof recordAudit === 'function') {
      recordAudit(getEventOrgId(event), 'transcript_cleared', { eventId: event.id, name: event.name, removed: transcriptCount });
    }
    saveDb();
    io.to(`event:${event.id}`).emit('transcripts_cleared', { eventId: event.id });
    res.json({ ok: true });
  });

  app.post('/api/events/:id/glossary', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const source = String(req.body.source || '').trim();
    const target = String(req.body.target || '').trim();
    const permanent = !!req.body.permanent;
    const lang = String(req.body.lang || '').trim();
    if (!source || !target) return res.status(400).json({ ok: false, error: 'Date lipsă.' });
    if (!lang) return res.status(400).json({ ok: false, error: 'Limbă lipsă.' });
    event.glossary[lang] = event.glossary[lang] || {};
    event.glossary[lang][source] = target;
    if (permanent) getOrganizationMemory(event)[`${lang.toUpperCase()}::${source}`] = target;
    saveDb();
    io.to(`event:${event.id}`).emit('glossary_updated', { source, target, permanent });
    res.json({ ok: true });
  });

  app.post('/api/events/:id/source-corrections', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const heard = String(req.body.heard || '').trim();
    const correct = String(req.body.correct || '').trim();
    const permanent = !!req.body.permanent;
    if (!heard || !correct) return res.status(400).json({ ok: false, error: 'Date lipsă.' });
    event.sourceCorrections = event.sourceCorrections || {};
    event.sourceCorrections[heard] = correct;
    if (permanent) getOrganizationMemory(event)[`SRC::${heard}`] = correct;
    saveDb();
    io.to(`event:${event.id}`).emit('source_corrections_updated', { heard, correct, permanent });
    res.json({ ok: true });
  });

  app.post('/api/events/:id/audio', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    if (typeof req.body.audioMuted === 'boolean') event.audioMuted = req.body.audioMuted;
    if (typeof req.body.audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, req.body.audioVolume));
    saveDb();
    io.to(`event:${event.id}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
    res.json({ ok: true, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/song/load', async (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    const title = String(req.body.title || '').trim();
    const text = sanitizeStructuredText(req.body.text || '');
    const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
    if (!text) return res.status(400).json({ ok: false, error: 'Text lipsă.' });
    try {
      const parsedSong = splitSongBlocksWithLabels(text, labels);
      const blocks = parsedSong.blocks;
      const songSourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';
      const firstBlockTranslations = blocks.length
        ? await buildSongTranslations(event, blocks.slice(0, 1), songSourceLang)
        : [];
      const placeholderTranslations = blocks.map((_, i) => firstBlockTranslations[i] || {});
      event.songState = {
        title,
        sourceLang: songSourceLang,
        blocks,
        blockLabels: parsedSong.labels,
        currentIndex: blocks.length ? 0 : -1,
        activeBlock: blocks[0] || null,
        translations: placeholderTranslations[0] || {},
        allTranslations: placeholderTranslations,
        updatedAt: new Date().toISOString()
      };
      event.mode = 'song';
      speechBuffers.delete(event.id);
      event.lastTranscriptNorm = '';
      setTranscriptionPaused(event, true, { save: false, emit: false, markOnAir: false });
      rememberDisplayState(event);
      ensureEventUiState(event);
      event.displayState.mode = 'song';
      event.displayState.blackScreen = false;
      event.displayState.sceneLabel = '';
      event.displayState.updatedAt = new Date().toISOString();
      recordScreenAction(event, 'song');
      io.to(`event:${event.id}`).emit('mode_changed', { mode: 'song' });
      io.to(`event:${event.id}`).emit('song_state', event.songState);
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
      saveDb();
      emitUsageStats(event.id);
      res.json({ ok: true, songState: event.songState, event: normalizeEventForAccess(req, event) });
      if (blocks.length > 1) {
        buildSongTranslations(event, blocks.slice(1), songSourceLang)
          .then((rest) => {
            const merged = [placeholderTranslations[0] || {}, ...rest];
            if (event.songState && event.songState.blocks === blocks) {
              event.songState.allTranslations = merged;
              event.songState.translations = merged[event.songState.currentIndex] || {};
              event.songState.updatedAt = new Date().toISOString();
              saveDb();
              io.to(`event:${event.id}`).emit('song_state', event.songState);
            }
          })
          .catch((err) => logger.error('song background translate:', err?.message || err));
      }
    } catch (err) {
      logger.error('song load error:', err);
      res.status(500).json({ ok: false, error: 'Nu am putut pregăti Song.' });
    }
  });

  app.post('/api/events/:id/song/show/:index', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    const index = Number(req.params.index);
    if (!setSongIndex(event, index)) return res.status(400).json({ ok: false, error: 'Index invalid.' });
    recordScreenAction(event, 'song');
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    res.json({ ok: true, songState: event.songState });
    saveDb();
    emitUsageStats(event.id);
  });

  app.post('/api/events/:id/song/labels', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
    const blocks = Array.isArray(event.songState?.blocks) ? event.songState.blocks : [];
    event.songState = event.songState || defaultSongState();
    event.songState.blockLabels = buildBlockLabels(blocks, labels);
    saveDb();
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    res.json({ ok: true, songState: event.songState });
  });

  app.post('/api/events/:id/song/next', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    const nextIndex = Number(event.songState?.currentIndex ?? -1) + 1;
    if (!setSongIndex(event, nextIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc următor.' });
    recordScreenAction(event, 'song');
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    res.json({ ok: true, songState: event.songState });
    saveDb();
    emitUsageStats(event.id);
  });

  app.post('/api/events/:id/song/prev', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    const prevIndex = Number(event.songState?.currentIndex ?? 0) - 1;
    if (!setSongIndex(event, prevIndex)) return res.status(400).json({ ok: false, error: 'Nu mai există bloc anterior.' });
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    res.json({ ok: true, songState: event.songState });
    saveDb();
  });

  app.post('/api/events/:id/song/clear', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;
    rememberDisplayState(event);
    event.songState = defaultSongState();
    event.mode = 'live';
    speechBuffers.delete(event.id);
    event.lastTranscriptNorm = '';
    ensureEventUiState(event);
    event.latestDisplayEntry = null;
    event.displayState.mode = 'auto';
    event.displayState.blackScreen = false;
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    saveDb();
    io.to(`event:${event.id}`).emit('song_clear');
    io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    res.json({ ok: true, event: normalizeEventForAccess(req, event) });
  });


  app.post('/api/events/:id/display/mode', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;

    ensureEventUiState(event);

    const mode = String(req.body.mode || '').trim().toLowerCase();
    if (!['auto', 'manual', 'song'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'Mod invalid.' });
    }
    if (mode === 'song') {
      if (!requireEventPermission(req, res, 'song')) return;
    } else if (!requireEventPermission(req, res, 'main_screen')) return;

    if (mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
      return res.status(400).json({ ok: false, error: 'Nu exista continut activ pentru Song.' });
    }

    rememberDisplayState(event);
    event.displayState.mode = mode;
    event.displayState.blackScreen = false;
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();

    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);

    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/display/theme', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;

    ensureEventUiState(event);
    const theme = String(req.body.theme || 'dark').trim();
    if (!['dark', 'light'].includes(theme)) {
      return res.status(400).json({ ok: false, error: 'Tema invalida.' });
    }

    rememberDisplayState(event);
    event.displayState.theme = theme;
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();

    io.to(`event:${event.id}`).emit('display_theme_changed', {
      theme: event.displayState.theme,
      updatedAt: event.displayState.updatedAt
    });
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);

    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
  });

  app.post('/api/events/:id/display/language', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);
    const language = String(req.body.language || '').trim();
    const hasSecondaryLanguage = Object.prototype.hasOwnProperty.call(req.body || {}, 'secondaryLanguage');
    const secondaryLanguage = hasSecondaryLanguage ? String(req.body.secondaryLanguage || '').trim() : event.displayState.secondaryLanguage || '';
    const allowedDisplayLanguages = getDisplayLanguageChoices(event);
    if (!allowedDisplayLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: 'Limba invalida pentru ecran.' });
    }
    if (secondaryLanguage && !allowedDisplayLanguages.includes(secondaryLanguage)) {
      return res.status(400).json({ ok: false, error: 'A doua limba este invalida pentru ecran.' });
    }
    rememberDisplayState(event);
    event.displayState.language = language;
    event.displayState.secondaryLanguage = secondaryLanguage && secondaryLanguage !== language ? secondaryLanguage : '';
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
  });

  app.post('/api/events/:id/display/settings', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);
    const backgroundPreset = typeof req.body.backgroundPreset === 'string' ? req.body.backgroundPreset.trim() : event.displayState.backgroundPreset;
    const customBackground = typeof req.body.customBackground === 'string' ? req.body.customBackground.trim() : event.displayState.customBackground;
    const showClock = typeof req.body.showClock === 'boolean' ? req.body.showClock : event.displayState.showClock;
    const clockPosition = typeof req.body.clockPosition === 'string' ? req.body.clockPosition.trim() : event.displayState.clockPosition;
    const clockScale = typeof req.body.clockScale === 'number' ? req.body.clockScale : event.displayState.clockScale;
    const textSize = typeof req.body.textSize === 'string' ? req.body.textSize.trim() : event.displayState.textSize;
    const textScale = typeof req.body.textScale === 'number' ? req.body.textScale : event.displayState.textScale;
    const screenStyle = typeof req.body.screenStyle === 'string' ? req.body.screenStyle.trim() : event.displayState.screenStyle;
    const displayResolution = typeof req.body.displayResolution === 'string' ? req.body.displayResolution.trim() : event.displayState.displayResolution;
    const secondaryLanguage = typeof req.body.secondaryLanguage === 'string' ? req.body.secondaryLanguage.trim() : event.displayState.secondaryLanguage || '';
    const allowedDisplayLanguages = getDisplayLanguageChoices(event);
    if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(backgroundPreset)) {
      return res.status(400).json({ ok: false, error: 'Preset fundal invalid.' });
    }
    if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(clockPosition)) {
      return res.status(400).json({ ok: false, error: 'Pozitie ceas invalida.' });
    }
    if (typeof clockScale !== 'number' || Number.isNaN(clockScale) || clockScale < 0.7 || clockScale > 1.8) {
      return res.status(400).json({ ok: false, error: 'Marime ceas invalida.' });
    }
    if (!['compact', 'large', 'xlarge'].includes(textSize)) {
      return res.status(400).json({ ok: false, error: 'Marime text invalida.' });
    }
    if (typeof textScale !== 'number' || Number.isNaN(textScale) || textScale < 0.65 || textScale > 1.4) {
      return res.status(400).json({ ok: false, error: 'Zoom text invalid.' });
    }
    if (!['focus', 'wide'].includes(screenStyle)) {
      return res.status(400).json({ ok: false, error: 'Layout ecran invalid.' });
    }
    if (!['auto', '16-9', '16-10', '4-3'].includes(displayResolution)) {
      return res.status(400).json({ ok: false, error: 'Rezolutie ecran invalida.' });
    }
    if (secondaryLanguage && !allowedDisplayLanguages.includes(secondaryLanguage)) {
      return res.status(400).json({ ok: false, error: 'A doua limba este invalida pentru ecran.' });
    }
    rememberDisplayState(event);
    event.displayState.backgroundPreset = backgroundPreset;
    event.displayState.customBackground = customBackground;
    event.displayState.showClock = !!showClock;
    event.displayState.clockPosition = clockPosition;
    event.displayState.clockScale = clockScale;
    event.displayState.textSize = textSize;
    event.displayState.textScale = normalizeDisplayTextScale(textScale, 1);
    event.displayState.screenStyle = screenStyle;
    event.displayState.displayResolution = displayResolution;
    event.displayState.secondaryLanguage = secondaryLanguage && secondaryLanguage !== event.displayState.language ? secondaryLanguage : '';
    event.displayState.sceneLabel = '';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null });
  });

  app.post('/api/events/:id/display/restore-last', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);
    if (!event.displayStatePrevious) {
      return res.status(400).json({ ok: false, error: 'Nu exista o stare anterioara pentru restore.' });
    }
    const currentSnapshot = cloneDisplaySnapshot(event);
    const previousSnapshot = event.displayStatePrevious;
    applyDisplaySnapshot(event, previousSnapshot);
    event.displayStatePrevious = currentSnapshot;
    recordScreenAction(event, 'display');
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
  });

  app.post('/api/events/:id/display/shortcut', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);

    const shortcutKey = String(req.body.shortcut || '').trim().toLowerCase();
    const shortcut = DISPLAY_SHORTCUTS[shortcutKey];
    if (!shortcut) {
      return res.status(400).json({ ok: false, error: 'Shortcut inexistent.' });
    }

    let mode = shortcut.mode;
    if (mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
      mode = 'auto';
    }
    if (mode === 'manual' && !event.displayState?.manualSource) {
      mode = 'auto';
    }

    rememberDisplayState(event);
    event.displayState.mode = mode;
    event.displayState.blackScreen = false;
    event.displayState.theme = shortcut.theme;
    event.displayState.language = event.targetLangs.includes(String(req.body.language || '').trim())
      ? String(req.body.language || '').trim()
      : (event.displayState.language || event.targetLangs[0] || 'no');
    if (event.displayState.secondaryLanguage === event.displayState.language) {
      event.displayState.secondaryLanguage = '';
    }
    event.displayState.backgroundPreset = shortcut.backgroundPreset;
    event.displayState.customBackground = shortcut.customBackground;
    event.displayState.showClock = !!shortcut.showClock;
    event.displayState.clockPosition = shortcut.clockPosition;
    event.displayState.textSize = shortcut.textSize;
    event.displayState.screenStyle = shortcut.screenStyle;
    event.displayState.sceneLabel = shortcut.label;
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();

    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, shortcut: shortcut.label, displayState: event.displayState, previousState: event.displayStatePrevious || null, event: normalizeEventForAccess(req, event) });
  });

  app.get('/api/events/:id/display-presets', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);
    res.json({ ok: true, presets: event.displayPresets });
  });

  app.post('/api/events/:id/display-presets', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    ensureEventUiState(event);

    const preset = normalizeDisplayPreset(req.body || {});
    if (!preset) {
      return res.status(400).json({ ok: false, error: 'Numele presetului lipseste.' });
    }
    if (!event.targetLangs.includes(preset.language)) {
      preset.language = event.targetLangs[0] || 'no';
    }
    if (preset.secondaryLanguage && (!event.targetLangs.includes(preset.secondaryLanguage) || preset.secondaryLanguage === preset.language)) {
      preset.secondaryLanguage = '';
    }

    const existingIndex = event.displayPresets.findIndex((item) => String(item.name || '').toLowerCase() === preset.name.toLowerCase());
    if (existingIndex >= 0) {
      preset.id = event.displayPresets[existingIndex].id;
      event.displayPresets[existingIndex] = preset;
    } else {
      event.displayPresets.unshift(preset);
    }
    if (event.displayPresets.length > 12) {
      event.displayPresets = event.displayPresets.slice(0, 12);
    }
    saveDb();
    io.to(`event:${event.id}:admins`).emit('display_presets_updated', { presets: event.displayPresets });
    res.json({ ok: true, presets: event.displayPresets });
  });

  app.post('/api/events/:id/display-presets/:presetId/apply', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);

    const preset = event.displayPresets.find((item) => item.id === req.params.presetId);
    if (!preset) {
      return res.status(404).json({ ok: false, error: 'Preset inexistent.' });
    }
    if (preset.mode === 'song' && !event.songState?.activeBlock && !event.songState?.translations) {
      return res.status(400).json({ ok: false, error: 'Presetul Song are nevoie de continut activ in Song.' });
    }

    rememberDisplayState(event);
    event.displayState.mode = preset.mode;
    event.displayState.blackScreen = false;
    event.displayState.theme = preset.theme;
    {
      const allowedDisplayLanguages = getDisplayLanguageChoices(event, preset.mode);
      event.displayState.language = allowedDisplayLanguages.includes(preset.language) ? preset.language : (allowedDisplayLanguages[0] || event.targetLangs[0] || 'no');
      event.displayState.secondaryLanguage = allowedDisplayLanguages.includes(preset.secondaryLanguage) && preset.secondaryLanguage !== event.displayState.language
        ? preset.secondaryLanguage
        : '';
    }
    event.displayState.backgroundPreset = preset.backgroundPreset;
    event.displayState.customBackground = preset.customBackground;
    event.displayState.showClock = !!preset.showClock;
    event.displayState.clockPosition = preset.clockPosition;
    event.displayState.textSize = preset.textSize;
    event.displayState.textScale = normalizeDisplayTextScale(preset.textScale, 1);
    event.displayState.screenStyle = preset.screenStyle;
    event.displayState.sceneLabel = preset.name;
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, presets: event.displayPresets });
  });

  app.delete('/api/events/:id/display-presets/:presetId', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    ensureEventUiState(event);
    event.displayPresets = event.displayPresets.filter((item) => item.id !== req.params.presetId);
    saveDb();
    io.to(`event:${event.id}:admins`).emit('display_presets_updated', { presets: event.displayPresets });
    res.json({ ok: true, presets: event.displayPresets });
  });

  app.post('/api/events/:id/display/blank', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);
    rememberDisplayState(event);
    event.displayState.blackScreen = true;
    event.displayState.sceneLabel = 'Black screen';
    event.displayState.updatedAt = new Date().toISOString();
    recordScreenAction(event, 'display');
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);
    res.json({ ok: true, event: normalizeEventForAccess(req, event), previousState: event.displayStatePrevious || null });
  });

  app.post('/api/events/:id/display/manual', async (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;

    ensureEventUiState(event);

    const text = sanitizeStructuredText(req.body.text || '');
    const title = String(req.body.title || '').trim();
    const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

    if (!text) {
      return res.status(400).json({ ok: false, error: 'Text lipsă.' });
    }

    try {
      const translations = await buildTranslationsForAllTargets(text, event, sourceLang);

      const entry = {
        id: randomUUID(),
        sourceLang,
        original: text,
        translations,
        createdAt: new Date().toISOString(),
        edited: false,
        manual: true,
        title: title || ''
      };

      event.transcripts.push(entry);
      if (event.transcripts.length > 300) {
        event.transcripts = event.transcripts.slice(-300);
      }

      rememberDisplayState(event);
      event.displayState = {
        ...event.displayState,
        mode: 'manual',
        blackScreen: false,
        sceneLabel: '',
        manualSource: text,
        manualSourceLang: sourceLang,
        manualTranslations: translations,
        updatedAt: new Date().toISOString()
      };

      event.mode = 'live';
      pushSongHistory(event, { title: title || 'Pinned text', kind: 'manual', source: text, translations });

      recordScreenAction(event, 'manual');
      saveDb();

      io.to(`event:${event.id}`).emit('transcript_entry', entry);
      io.to(`event:${event.id}`).emit('display_manual_update', buildDisplayPayload(event));
      io.to(`event:${event.id}`).emit('song_history_updated', {
        songHistory: event.songHistory
      });
      emitUsageStats(event.id);

      res.json({ ok: true, displayState: event.displayState, previousState: event.displayStatePrevious || null, songHistory: event.songHistory });
    } catch (err) {
      logger.error('display manual error:', err);
      res.status(500).json({ ok: false, error: 'Nu am putut trimite textul pe ecran.' });
    }
  });

  app.post('/api/events/:id/song-library', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;

    ensureEventUiState(event);

    const title = String(req.body.title || '').trim();
    const text = sanitizeStructuredText(req.body.text || '');
    const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
    const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

    if (!title || !text) {
      return res.status(400).json({ ok: false, error: 'Titlu sau text lipsă.' });
    }

    upsertLibraryItem(event.songLibrary, { title, text, labels, sourceLang }, 100);

    saveDb();
    res.json({ ok: true, songLibrary: event.songLibrary });
  });

  app.get('/api/events/:id/song-library', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });

    ensureEventUiState(event);
    res.json({ ok: true, songLibrary: event.songLibrary });
  });

  app.delete('/api/events/:id/song-library/:songId', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;

    ensureEventUiState(event);
    event.songLibrary = event.songLibrary.filter((item) => item.id !== req.params.songId);
    saveDb();

    res.json({ ok: true, songLibrary: event.songLibrary });
  });

  app.get('/api/global-song-library', (req, res) => {
    const library = getOrganizationSongLibrary(DEFAULT_ORG_ID);
    res.json({ ok: true, globalSongLibrary: Array.isArray(library) ? library : [], organization: buildPublicOrganization() });
  });

  app.post('/api/global-song-library', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const title = String(req.body.title || '').trim();
    const text = sanitizeStructuredText(req.body.text || '');
    const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
    const sourceLang = String(req.body.sourceLang || 'ro').trim() || 'ro';
    if (!title || !text) {
      return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
    }
    const library = getOrganizationSongLibrary(DEFAULT_ORG_ID);
    upsertLibraryItem(library, { title, text, labels, sourceLang }, 500);
    saveDb();
    res.json({ ok: true, globalSongLibrary: library });
  });

  app.get('/api/pinned-text-library', (req, res) => {
    const library = getOrganizationPinnedTextLibrary(DEFAULT_ORG_ID);
    res.json({ ok: true, pinnedTextLibrary: Array.isArray(library) ? library : [], organization: buildPublicOrganization() });
  });

  app.post('/api/pinned-text-library', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const title = String(req.body.title || '').trim();
    const text = sanitizeStructuredText(req.body.text || '');
    const sourceLang = String(req.body.sourceLang || 'ro').trim() || 'ro';
    if (!title || !text) {
      return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
    }
    const library = getOrganizationPinnedTextLibrary(DEFAULT_ORG_ID);
    upsertLibraryItem(library, { title, text, labels: [], sourceLang }, 300);
    saveDb();
    res.json({ ok: true, pinnedTextLibrary: library });
  });

  app.delete('/api/pinned-text-library/:itemId', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const org = getDefaultOrganization();
    org.pinnedTextLibrary = (org.pinnedTextLibrary || []).filter((item) => item.id !== req.params.itemId);
    saveDb();
    res.json({ ok: true, pinnedTextLibrary: org.pinnedTextLibrary });
  });

  app.delete('/api/global-song-library/:songId', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const org = getDefaultOrganization();
    org.globalSongLibrary = (org.globalSongLibrary || []).filter((item) => item.id !== req.params.songId);
    saveDb();
    res.json({ ok: true, globalSongLibrary: org.globalSongLibrary });
  });

  app.get('/api/events/:id/global-song-library', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });

    const library = getOrganizationSongLibrary(getEventOrgId(event));
    res.json({ ok: true, globalSongLibrary: Array.isArray(library) ? library : [] });
  });

  app.post('/api/events/:id/global-song-library', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;

    const title = String(req.body.title || '').trim();
    const text = sanitizeStructuredText(req.body.text || '');
    const labels = Array.isArray(req.body.labels) ? req.body.labels : [];
    const sourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

    if (!title || !text) {
      return res.status(400).json({ ok: false, error: 'Titlu sau text lipsa.' });
    }

    const library = getOrganizationSongLibrary(getEventOrgId(event));
    upsertLibraryItem(library, { title, text, labels, sourceLang }, 500);
    saveDb();
    res.json({ ok: true, globalSongLibrary: library });
  });

  app.post('/api/events/:id/global-song-library/:songId/add-to-event', (req, res) => {
    const adminEvent = db.events[req.params.id];
    if (!adminEvent) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, adminEvent)) return;

    const targetEventId = String(req.body?.targetEventId || req.params.id || '').trim();
    const event = db.events[targetEventId];
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Evenimentul selectat nu exista.' });
    }

    ensureEventUiState(event);
    if (getEventOrgId(adminEvent) !== getEventOrgId(event)) {
      return res.status(403).json({ ok: false, error: 'Evenimentul selectat apartine altei organizatii.' });
    }
    const library = getOrganizationSongLibrary(getEventOrgId(adminEvent));
    const item = (library || []).find((entry) => entry.id === req.params.songId);
    if (!item) {
      return res.status(404).json({ ok: false, error: 'Cantarea nu exista in biblioteca generala.' });
    }

    upsertLibraryItem(event.songLibrary, { title: item.title, text: item.text, labels: item.labels || [], sourceLang: item.sourceLang || event.sourceLang || 'ro' }, 100);
    saveDb();
    res.json({ ok: true, targetEvent: summarizeEvent(event), songLibrary: event.songLibrary, globalSongLibrary: library });
  });

  app.delete('/api/events/:id/global-song-library/:songId', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;

    const org = getOrganizationForEvent(event);
    org.globalSongLibrary = (org.globalSongLibrary || []).filter((item) => item.id !== req.params.songId);
    saveDb();
    res.json({ ok: true, globalSongLibrary: org.globalSongLibrary });
  });

  function getClientIp(req) {
    const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwardedFor || req.socket?.remoteAddress || req.ip || 'unknown';
  }

  function cleanupTranscribeRateLimits(now = Date.now()) {
    if (transcribeRateLimits.size < 500) return;
    for (const [key, entry] of transcribeRateLimits.entries()) {
      if (now - entry.windowStart > TRANSCRIBE_RATE_LIMIT_WINDOW_MS * 2) {
        transcribeRateLimits.delete(key);
      }
    }
  }

  function consumeTranscribeRateLimit(req, eventId) {
    const now = Date.now();
    const key = `${getClientIp(req)}:${eventId || 'unknown'}`;
    const existing = transcribeRateLimits.get(key);
    if (!existing || now - existing.windowStart >= TRANSCRIBE_RATE_LIMIT_WINDOW_MS) {
      transcribeRateLimits.set(key, { windowStart: now, count: 1 });
      cleanupTranscribeRateLimits(now);
      return {
        allowed: true,
        remaining: Math.max(0, TRANSCRIBE_RATE_LIMIT_MAX - 1),
        resetAt: now + TRANSCRIBE_RATE_LIMIT_WINDOW_MS
      };
    }

    existing.count += 1;
    const resetAt = existing.windowStart + TRANSCRIBE_RATE_LIMIT_WINDOW_MS;
    if (existing.count > TRANSCRIBE_RATE_LIMIT_MAX) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000))
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, TRANSCRIBE_RATE_LIMIT_MAX - existing.count),
      resetAt
    };
  }

  function transcribeRateLimit(req, res, next) {
    const result = consumeTranscribeRateLimit(req, req.params.id);
    res.setHeader('X-RateLimit-Limit', String(TRANSCRIBE_RATE_LIMIT_MAX));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: 'Prea multe cereri de transcriere. Incearca din nou imediat.'
      });
    }
    return next();
  }

  app.post('/api/events/:id/transcribe', transcribeRateLimit, upload.single('audio'), async (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    const access = resolveEventAccessFromCode(event, String(req.body.code || '').trim());
    if (access.role !== 'admin') return res.status(403).json({ ok: false, error: 'Cod Admin invalid.' });
    if (!client) return res.status(400).json({ ok: false, error: 'OpenAI nu este configurat.' });
    if (!req.file || !req.file.buffer?.length) return res.status(400).json({ ok: false, error: 'Audio lipsă.' });

    const mimeType = String(req.file.mimetype || 'audio/webm');
    const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm';
    const tempPath = path.join(os.tmpdir(), `sanctuary-voice-${randomUUID()}.${ext}`);

    const startedAt = Date.now();
    try {
      fs.writeFileSync(tempPath, req.file.buffer);
      const rawTranscript = await transcribeAudioFile(tempPath, event);
      if (typeof recordTranscribeLatency === 'function') {
        recordTranscribeLatency(Date.now() - startedAt);
      }
      if (typeof recordTranscribeUsage === 'function') {
        const estimatedSeconds = Math.max(0.5, (req.file.buffer.length || 0) / 4000);
        recordTranscribeUsage(event, estimatedSeconds);
      }
      if (typeof appendAudioArchiveChunk === 'function') {
        appendAudioArchiveChunk(event, req.file.buffer);
      }
      const transcriptText = typeof rawTranscript === 'string' ? rawTranscript : rawTranscript?.text;
      const transcriptSourceLang = typeof rawTranscript === 'object' && rawTranscript?.sourceLang
        ? rawTranscript.sourceLang
        : (event.liveSourceLang || event.sourceLang || 'ro');
      const transcript = applySourceCorrections(sanitizeTranscriptText(transcriptText), getSourceCorrections(event));
      if (!transcript) return res.json({ ok: true, skipped: true });
      queueSpeechText(event.id, transcript, transcriptSourceLang);
      return res.json({ ok: true, text: transcript, sourceLang: transcriptSourceLang, buffered: true });
    } catch (err) {
      logger.error('transcribe error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'Nu am putut transcrie audio.' });
    } finally {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  });
}

module.exports = {
  registerEventRoutes
};
