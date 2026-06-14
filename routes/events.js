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
    deriveScheduledFields,   // WORSHIP-RESCHEDULE
    LANGUAGES,
    LANGUAGE_NAMES_RO,
    LANGUAGE_ENDONYMS,
    TRANSCRIBE_RATE_LIMIT_MAX,
    TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
    appendAudioArchiveChunk,
    audioArchivePath,
    applyDisplaySnapshot,
    applySourceCorrections,
    buildBaseUrl,
    buildBlockLabels,
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
    getDefaultOrganization,
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
    normalizeLibraryTitle,
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
    requireAdminOrOperatorApiSession,   // OPERATOR-PARITY-B
    tryWorshipSession,
    broadcastPermanentWorshipView,
    resolveEventAccessFromCode,
    normalizeTextInput,
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
    res.json({ ok: true, event: normalizeEvent(event), languageNames: LANGUAGE_NAMES_RO, languageEndonyms: LANGUAGE_ENDONYMS, organization: buildPublicOrganization(getOrganizationForEvent(event)) });
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
    res.json({ ok: true, events, activeEventId: activeEventId || null, languageNames: LANGUAGE_NAMES_RO, languageEndonyms: LANGUAGE_ENDONYMS, organization: buildPublicOrganization() });
  });

  app.get('/api/events', (req, res) => {
    // FIX-OPERATOR-EVENT-LIST — operatorul are nevoie de listă pt selectorul de eveniment (OPERATOR-EVENT-PICKER).
    // Era requireAdminApiSession (admin-only) → operatorul primea 401/403 → catch silent → listă goală (regresie).
    // requireAdminOrOperatorApiSession acceptă admin + operator-PIN(cookie) + worship pe ORICE request, dar
    // codul de EVENT îl citește DOAR din req.body → la un GET (fără body) ar pica pt operatorul pe cod de event.
    // De aceea acceptăm întâi codul admin/screen trimis pe query/header (getSuppliedEventCode), apoi fallback pe gate.
    // summarizeEvent = doar metadate + linkuri publice, FĂRĂ secrete (fără adminCode/coduri) → sigur pt operator.
    if (COMMERCIAL_MODE || isAdminLoginConfigured()) {
      let allowed = false;
      const codeEventId = String(req.query?.eventId || req.body?.eventId || '').trim();
      const codeEvent = codeEventId ? db.events[codeEventId] : null;
      const suppliedCode = getSuppliedEventCode(req);
      if (codeEvent && suppliedCode) {
        const access = resolveEventAccessFromCode(codeEvent, suppliedCode);
        if (access.role === 'admin' || access.role === 'screen') allowed = true;
      }
      if (!allowed && !requireAdminOrOperatorApiSession(req, res)) return;
    }
    const activeEventId = getActiveEventIdForOrg(DEFAULT_ORG_ID);
    const events = getOrganizationEvents(DEFAULT_ORG_ID)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(summarizeEvent);
    res.json({ ok: true, events, activeEventId: activeEventId || null, languageNames: LANGUAGE_NAMES_RO, languageEndonyms: LANGUAGE_ENDONYMS, organization: buildPublicOrganization() });
  });

  app.get('/api/events/:id', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    ensureEventAccessLinks(event, buildBaseUrl(req));
    saveDb();
    const access = hasValidAdminSession(req)
      ? { role: 'admin', permissions: ['main_screen', 'song'], operator: null }
      : resolveEventAccessFromCode(event, getSuppliedEventCode(req));
    res.json({ ok: true, event: normalizeEvent(event, { includeSecrets: access.role === 'admin' }), languageNames: LANGUAGE_NAMES_RO, languageEndonyms: LANGUAGE_ENDONYMS, organization: buildPublicOrganization(getOrganizationForEvent(event)) });
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

  // WORSHIP-DRAFT-34: admin approves a worship draft event → becomes a normal event (can go live).
  // Same admin-code gate as /activate, for consistency. worshipDraft remains true (audit trail);
  // only `approved` controls visibility/live-eligibility.
  app.post('/api/events/:id/approve', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    event.approved = true;
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      event.name = req.body.name.trim().slice(0, 120);
    }
    saveDb();
    setImmediate(() => io.emit('active_event_changed', { eventId: event.id }));
    logger.info('[admin] approved worship draft:', event.id, 'name=', event.name);
    return res.json({ ok: true, eventId: event.id });
  });

  // WORSHIP-DRAFT-RENAME: admin can rename any event (draft or normal) anytime.
  // Same admin-code gate as /approve.
  app.post('/api/events/:id/rename', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Numele e obligatoriu.' });
    event.name = name.slice(0, 120);
    saveDb();
    setImmediate(() => io.emit('active_event_changed', { eventId: event.id }));
    logger.info('[admin] renamed event:', event.id, '→', event.name);
    return res.json({ ok: true, eventId: event.id, name: event.name });
  });

  // WORSHIP-RESCHEDULE: admin editează data + ora unui eveniment (same admin-code gate).
  // Folosește deriveScheduledFields (din server.js) — aceeași calculație ca la creare,
  // inclusiv timezone (păstrăm timezone-ul existent dacă nu vine altul în body).
  app.post('/api/events/:id/reschedule', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    const date = String(req.body?.date || '').trim();   // YYYY-MM-DD
    const time = String(req.body?.time || '').trim();    // HH:MM (poate fi gol)
    if (!date) return res.status(400).json({ ok: false, error: 'Data e obligatorie.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Format dată invalid (AAAA-LL-ZZ).' });
    }
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ ok: false, error: 'Format oră invalid (HH:MM).' });
    }
    const tz = String(req.body?.timezone || event.timezone || '').trim() || null;
    const scheduling = deriveScheduledFields({
      scheduledDate: date,
      scheduledTime: time || null,
      timezone: tz,
      scheduledAt: null
    });
    if (!scheduling.scheduledTimestamp) {
      return res.status(400).json({ ok: false, error: 'Dată/oră invalidă.' });
    }
    event.scheduledDate = scheduling.scheduledDate;
    event.scheduledTime = scheduling.scheduledTime;
    event.scheduledAt = scheduling.scheduledAt;
    event.scheduledTimestamp = scheduling.scheduledTimestamp;
    if (scheduling.timezone) event.timezone = scheduling.timezone;
    saveDb();
    setImmediate(() => io.emit('active_event_changed', { eventId: event.id }));
    logger.info('[admin] rescheduled event:', event.id, '→', event.scheduledAt);
    return res.json({
      ok: true,
      eventId: event.id,
      scheduledAt: event.scheduledAt,
      scheduledDate: event.scheduledDate,
      scheduledTime: event.scheduledTime,
      scheduledTimestamp: event.scheduledTimestamp
    });
  });

  app.post('/api/events/:id/activate', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventAdmin(req, res, event)) return;
    // WORSHIP-DRAFT-1: draft neaprobat NU poate merge live. Admin trebuie să aprobe întâi.
    if (event.approved === false) {
      return res.status(403).json({ ok: false, error: 'Eveniment draft — trebuie aprobat înainte de a merge live.' });
    }
    const orgId = getEventOrgId(event);
    // FEATURE 2: Default Black Screen pe pornire serviciu.
    // Doar dacă evenimentul NU era deja active (real "start service", nu re-activare în timpul serviciului).
    const wasAlreadyActive = getActiveEventIdForOrg(orgId) === event.id;
    setActiveEventIdForOrg(orgId, event.id);
    // FIX-ACTIVE-EVENT-3 — start instant la skip countdown. NU punem null: ensureEventAccessLinks()
    // (apelat la fiecare /api/events/public) ar re-deriva scheduledTimestamp din scheduledAt și
    // countdown-ul ar reveni la participanți. În schimb forțăm timestamp-ul ÎN TRECUT → countdown
    // gata (isScheduledInFuture=false → participantul face join), iar valoarea fiind 'number'
    // ensureEventAccessLinks NU o mai regenerează. Păstrăm scheduledAt (ora originală în afișaj/istoric).
    if (req.body && req.body.skipCountdown === true && typeof event.scheduledTimestamp === 'number') {
      event.scheduledTimestamp = Date.now() - 60 * 1000;
    }
    if (!wasAlreadyActive) {
      ensureEventUiState(event);
      rememberDisplayState(event);
      event.displayState.blackScreen = true;
      event.displayState.sceneLabel = '';
      event.displayState.updatedAt = new Date().toISOString();
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    }
    if (typeof recordAudit === 'function') {
      recordAudit(orgId, 'event_set_live', { eventId: event.id, name: event.name });
    }
    saveDb();
    io.emit('active_event_changed', { eventId: event.id });
    // V21.18: refresh permanent worship-view subscribers when the live event flips.
    if (typeof broadcastPermanentWorshipView === 'function') broadcastPermanentWorshipView();
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
    // SEC-AUDIT-2026-06 C2: remove the event's audio archive so deleted events
    // don't leave orphaned .webm files accumulating on the data disk.
    if (AUDIO_ARCHIVE_ENABLED && typeof audioArchivePath === 'function') {
      try { fs.unlinkSync(audioArchivePath(req.params.id)); } catch (_) { /* no archive or already gone */ }
    }
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
    // V21.18: refresh permanent worship-view subscribers when the live event flips.
    if (typeof broadcastPermanentWorshipView === 'function') broadcastPermanentWorshipView();
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
    // BUGFIX V7: glossary entries don't go through sanitizeStructuredText, so normalize directly.
    // Otherwise a glossary key with mixed sedilla/comma diacritics wouldn't match normalized song text.
    const source = normalizeTextInput(String(req.body.source || '')).trim();
    const target = normalizeTextInput(String(req.body.target || '')).trim();
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
    // V21.12: stage=true loads the song into songState WITHOUT switching
    // the projector (no mode/displayState change, no transcription pause,
    // no emits). The first /song/show then activates song mode.
    const stage = req.body && req.body.stage === true;
    if (!text) return res.status(400).json({ ok: false, error: 'Text lipsă.' });
    try {
      const parsedSong = splitSongBlocksWithLabels(text, labels);
      const blocks = parsedSong.blocks;
      const songSourceLang = String(req.body.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

      // Caut cache-ul existent în library pentru acest cântec (matchuit pe titlu normalizat).
      // Cântecele nesalvate (ex: paste direct în editor) nu au entry în library, deci songCache = {}
      // și totul se traduce normal. Cache-ul se persistă doar pentru cântecele salvate în library.
      const orgLibrary = getOrganizationSongLibrary(getEventOrgId(event)) || [];
      const normalizedLoadTitle = normalizeLibraryTitle(title);
      const cachedSongIndex = normalizedLoadTitle
        ? orgLibrary.findIndex((item) => item && normalizeLibraryTitle(item.title) === normalizedLoadTitle)
        : -1;
      const cachedSong = cachedSongIndex >= 0 ? orgLibrary[cachedSongIndex] : null;
      const songCache = (cachedSong && typeof cachedSong.translationsByHash === 'object' && cachedSong.translationsByHash)
                        ? cachedSong.translationsByHash : {};

      const persistCacheUpdates = (extraUpdates) => {
        if (cachedSongIndex < 0) return;
        const merged = { ...songCache, ...extraUpdates };
        if (Object.keys(merged).length === 0) return;
        const lib = getOrganizationSongLibrary(getEventOrgId(event));
        if (!Array.isArray(lib)) return;
        const idx = lib.findIndex((item) => item && normalizeLibraryTitle(item.title) === normalizedLoadTitle);
        if (idx < 0) return;
        lib[idx].translationsByHash = merged;
        lib[idx].updatedAt = new Date().toISOString();
        saveDb();
      };

      const firstResult = blocks.length
        ? await buildSongTranslations(event, blocks.slice(0, 1), songSourceLang, songCache)
        : { allTranslations: [], cacheUpdates: {} };
      const firstBlockTranslations = firstResult.allTranslations;
      const placeholderTranslations = blocks.map((_, i) => firstBlockTranslations[i] || {});
      event.songState = {
        title,
        sourceLang: songSourceLang,
        blocks,
        blockLabels: parsedSong.labels,
        // V21.12: a staged song has nothing live yet — currentIndex -1
        // so the Song Blocks UI shows no "Live now" block.
        currentIndex: stage ? -1 : (blocks.length ? 0 : -1),
        activeBlock: stage ? null : (blocks[0] || null),
        translations: placeholderTranslations[0] || {},
        allTranslations: placeholderTranslations,
        updatedAt: new Date().toISOString()
      };
      // V21.12: staged load — songState is ready; the projector is left
      // exactly as it was. Early-return so the non-stage path below is
      // byte-identical to the pre-V21.12 behaviour (zero regression).
      if (stage) {
        saveDb();
        res.json({ ok: true, songState: event.songState, event: normalizeEventForAccess(req, event) });
        if (blocks.length > 1) {
          buildSongTranslations(event, blocks.slice(1), songSourceLang, songCache)
            .then((restResult) => {
              const merged = [placeholderTranslations[0] || {}, ...restResult.allTranslations];
              if (event.songState && event.songState.blocks === blocks) {
                event.songState.allTranslations = merged;
                event.songState.translations = merged[event.songState.currentIndex] || {};
                event.songState.updatedAt = new Date().toISOString();
                saveDb();
                // No song_state emit — a staged song must not reach the
                // projector until the operator shows a block.
              }
              persistCacheUpdates({ ...firstResult.cacheUpdates, ...restResult.cacheUpdates });
            })
            .catch((err) => logger.error('song staged translate:', err?.message || err));
        } else {
          persistCacheUpdates(firstResult.cacheUpdates);
        }
        return;
      }
      event.mode = 'song';
      speechBuffers.delete(event.id);
      event.lastTranscriptNorm = '';
      setTranscriptionPaused(event, true, { save: false, emit: false, markOnAir: false });
      // V11.9: flip displayState.mode = 'song' BEFORE rememberDisplayState (and the
      // explicit ensureEventUiState below). Otherwise, when Send Song follows a Clear
      // (which leaves displayState.mode='auto' but displayState.language='ro' from the
      // prior song source), the inner ensureEventUiState in rememberDisplayState evicts
      // dual-mode pairs: getDisplayLanguageChoices() with mode='auto' returns just
      // event.targetLangs (e.g. ['no','en']), so primary 'ro' → 'no' (first target),
      // then secondary 'no' → '' (because secondary === primary). V11.8 then puts
      // 'ro' back on primary but secondary is already gone → single RO (the bug).
      // Setting mode='song' first means getDisplayLanguageChoices() includes
      // songState.sourceLang, preserving dual RO+NO across Clear → Send Song RO.
      if (event.displayState && typeof event.displayState === 'object') {
        event.displayState.mode = 'song';
      }
      rememberDisplayState(event);
      event.displayState.mode = 'song'; // re-assert: handles brand-new events where rememberDisplayState's ensureEventUiState just created default displayState
      ensureEventUiState(event);
      event.displayState.blackScreen = false;
      event.displayState.sceneLabel = '';
      // V11.8: switch displayState.language to song's source language so Main Screen
      // auto-shows the original verse text on Send (without admin manually switching
      // the display language). Dual-mode no-op: if sourceLang is already visible on
      // primary OR secondary card, preserve the operator's dual-mode choice. Update
      // happens BEFORE buildDisplayPayload below so the emit carries the new language.
      // Participant phone selection (state.currentLanguage in participant.js) is in a
      // separate state slot and is NOT affected by display_mode_changed payload (verified).
      {
        const currentPrimary = event.displayState.language || '';
        const currentSecondary = event.displayState.secondaryLanguage || '';
        if (currentPrimary !== songSourceLang && currentSecondary !== songSourceLang) {
          event.displayState.language = songSourceLang;
        }
      }
      event.displayState.updatedAt = new Date().toISOString();
      recordScreenAction(event, 'song');
      io.to(`event:${event.id}`).emit('mode_changed', { mode: 'song' });
      io.to(`event:${event.id}`).emit('song_state', event.songState);
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
      saveDb();
      emitUsageStats(event.id);
      res.json({ ok: true, songState: event.songState, event: normalizeEventForAccess(req, event) });
      if (blocks.length > 1) {
        buildSongTranslations(event, blocks.slice(1), songSourceLang, songCache)
          .then((restResult) => {
            const merged = [placeholderTranslations[0] || {}, ...restResult.allTranslations];
            if (event.songState && event.songState.blocks === blocks) {
              event.songState.allTranslations = merged;
              event.songState.translations = merged[event.songState.currentIndex] || {};
              event.songState.updatedAt = new Date().toISOString();
              saveDb();
              io.to(`event:${event.id}`).emit('song_state', event.songState);
            }
            persistCacheUpdates({ ...firstResult.cacheUpdates, ...restResult.cacheUpdates });
          })
          .catch((err) => logger.error('song background translate:', err?.message || err));
      } else {
        persistCacheUpdates(firstResult.cacheUpdates);
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
    // V21.12: if the song was staged (loaded with {stage:true}), the
    // projector is still in its previous mode. The first /song/show is
    // the staged song "going live" — activate song mode here, mirroring
    // the mode/transcription/displayState steps that /song/load does in
    // its non-stage path. For a normal (non-staged) load displayState
    // is already 'song', so this block is a no-op — zero regression.
    let songModeActivated = false;
    if (event.displayState && event.displayState.mode !== 'song') {
      event.mode = 'song';
      speechBuffers.delete(event.id);
      event.lastTranscriptNorm = '';
      setTranscriptionPaused(event, true, { save: false, emit: false, markOnAir: false });
      rememberDisplayState(event);
      event.displayState.mode = 'song';
      event.displayState.blackScreen = false;
      event.displayState.sceneLabel = '';
      songModeActivated = true;
    }
    // V11.8: same dual-mode no-op as /song/load — switch displayState.language to verse's
    // source on jump-to-verse. /song/show emits ONLY song_state today, so we also emit
    // display_mode_changed (conditionally, only if language actually changed) so Main Screen
    // picks up the new language. Flag avoids redundant emits + Main Screen re-render on no-op.
    let displayLanguageChanged = false;
    const verseSourceLang = event.songState?.sourceLang || event.sourceLang || 'ro';
    if (event.displayState) {
      const currentPrimary = event.displayState.language || '';
      const currentSecondary = event.displayState.secondaryLanguage || '';
      if (currentPrimary !== verseSourceLang && currentSecondary !== verseSourceLang) {
        event.displayState.language = verseSourceLang;
        event.displayState.updatedAt = new Date().toISOString();
        displayLanguageChanged = true;
      }
    }
    io.to(`event:${event.id}`).emit('song_state', event.songState);
    // V21.12: when a staged song goes live, also announce the mode flip
    // so the projector switches to song view. display_mode_changed
    // already covers the language case below; mode_changed is needed too.
    if (songModeActivated) {
      io.to(`event:${event.id}`).emit('mode_changed', { mode: 'song' });
    }
    if (displayLanguageChanged || songModeActivated) {
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    }
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

  // FEATURE 3+4: Edit the currently active song block, with optional library update.
  // Cache (translationsByHash) is content-addressed so new text auto-misses old cache;
  // when updateLibrary is true we also persist the new block translations into the library cache.
  app.post('/api/events/:id/song/edit-active-block', async (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;

    const newText = sanitizeStructuredText(req.body.newText || '').trim();
    if (!newText) return res.status(400).json({ ok: false, error: 'newText required' });
    const updateLibrary = !!req.body.updateLibrary;

    const songState = event.songState;
    if (!songState || !Array.isArray(songState.blocks) || !songState.blocks.length) {
      return res.status(400).json({ ok: false, error: 'No active song to edit.' });
    }
    const currentIndex = Number.isInteger(songState.currentIndex) ? songState.currentIndex : -1;
    if (currentIndex < 0 || currentIndex >= songState.blocks.length) {
      return res.status(400).json({ ok: false, error: 'No active block to edit.' });
    }

    songState.blocks[currentIndex] = newText;
    songState.activeBlock = newText;
    const songSourceLang = String(songState.sourceLang || event.sourceLang || 'ro').trim() || 'ro';

    // FEATURE 4: invalidate translations cache pentru blocul editat.
    // Forțăm re-traducere doar a blocului curent (nu pierdem traducerile pentru celelalte strofe).
    if (!Array.isArray(songState.allTranslations)) {
      songState.allTranslations = songState.blocks.map(() => ({}));
    }
    songState.allTranslations[currentIndex] = {};
    songState.translations = {};

    let updatedLibrary = null;
    try {
      // Caut entry-ul în library pentru a re-folosi cache-ul (titlu normalizat).
      const orgId = getEventOrgId(event);
      const orgLibrary = getOrganizationSongLibrary(orgId) || [];
      const normalizedTitle = normalizeLibraryTitle(songState.title || '');
      const libIdx = normalizedTitle
        ? orgLibrary.findIndex((item) => item && normalizeLibraryTitle(item.title) === normalizedTitle)
        : -1;
      const cachedSong = libIdx >= 0 ? orgLibrary[libIdx] : null;
      const songCache = (cachedSong && typeof cachedSong.translationsByHash === 'object' && cachedSong.translationsByHash)
                        ? cachedSong.translationsByHash : {};

      const result = await buildSongTranslations(event, [newText], songSourceLang, songCache);
      const blockTranslations = result.allTranslations[0] || {};
      songState.allTranslations[currentIndex] = blockTranslations;
      songState.translations = blockTranslations;
      songState.updatedAt = new Date().toISOString();

      if (updateLibrary && libIdx >= 0) {
        // Reconstruim textul complet din blocks + persistăm noile traduceri în cache-ul library-ului.
        orgLibrary[libIdx].text = songState.blocks.join('\n\n');
        if (Array.isArray(songState.blockLabels)) {
          orgLibrary[libIdx].labels = songState.blockLabels.slice();
        }
        const mergedCache = { ...songCache, ...result.cacheUpdates };
        orgLibrary[libIdx].translationsByHash = mergedCache;
        orgLibrary[libIdx].updatedAt = new Date().toISOString();
        updatedLibrary = orgLibrary;
      }

      saveDb();
      io.to(`event:${event.id}`).emit('song_state', event.songState);

      res.json({
        ok: true,
        event: normalizeEventForAccess(req, event),
        songState: event.songState,
        globalSongLibrary: updatedLibrary
      });
    } catch (err) {
      logger.error('song edit-active-block error:', err);
      res.status(500).json({ ok: false, error: 'Could not save edited verse.' });
    }
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
    // V21.33: Clear = negru și rămâne (server-side, global admin + operator).
    // Anterior setam mode='auto' + blackScreen=false → proiectorul intra în
    // live-follow și afișa instant display_live_entry. Admin masca cu un
    // blankMainScreen() pe client; operatorul NU avea petic → bug în slujbă.
    // Acum facem corect server-side: rămâne pe 'song' (păstrăm modul
    // semantic — utilizatorul tocmai era pe Song) și forțăm blackScreen=true.
    // rememberDisplayState (V11.x) e apelat la începutul handlerului → Restore
    // pe admin readuce starea anterioară Clear-ului, neatinsă.
    event.displayState.mode = 'song';
    event.displayState.blackScreen = true;
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

    io.to(`event:${event.id}`).emit('display_mode_changed', { ...buildDisplayPayload(event), explicit: true });
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
    if (!['compact', 'large', 'xlarge', 'huge'].includes(textSize)) {
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

  // Endpoint minimalist pentru schimbări instant pe Main Screen.
  // Folosit de operator (zoom +/- pe text) și de admin (instant apply pe orice setare).
  // Acceptă oricare din câmpurile display, doar le validează pe cele primite.
  app.post('/api/events/:id/display/text', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);

    let changed = false;

    if (typeof req.body.textSize === 'string') {
      const textSize = req.body.textSize.trim();
      if (!['compact', 'large', 'xlarge', 'huge'].includes(textSize)) {
        return res.status(400).json({ ok: false, error: 'Marime text invalida.' });
      }
      event.displayState.textSize = textSize;
      changed = true;
    }
    if (typeof req.body.textScale === 'number') {
      if (Number.isNaN(req.body.textScale) || req.body.textScale < 0.65 || req.body.textScale > 1.4) {
        return res.status(400).json({ ok: false, error: 'Zoom text invalid.' });
      }
      event.displayState.textScale = normalizeDisplayTextScale(req.body.textScale, 1);
      changed = true;
    }
    if (typeof req.body.backgroundPreset === 'string') {
      const v = req.body.backgroundPreset.trim();
      if (!['none', 'warm', 'sanctuary', 'soft-light'].includes(v)) {
        return res.status(400).json({ ok: false, error: 'Preset fundal invalid.' });
      }
      event.displayState.backgroundPreset = v;
      changed = true;
    }
    if (typeof req.body.customBackground === 'string') {
      event.displayState.customBackground = req.body.customBackground.trim();
      changed = true;
    }
    if (typeof req.body.showClock === 'boolean') {
      event.displayState.showClock = req.body.showClock;
      changed = true;
    }
    if (typeof req.body.clockPosition === 'string') {
      const v = req.body.clockPosition.trim();
      if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(v)) {
        return res.status(400).json({ ok: false, error: 'Pozitie ceas invalida.' });
      }
      event.displayState.clockPosition = v;
      changed = true;
    }
    if (typeof req.body.clockScale === 'number') {
      if (Number.isNaN(req.body.clockScale) || req.body.clockScale < 0.7 || req.body.clockScale > 1.8) {
        return res.status(400).json({ ok: false, error: 'Marime ceas invalida.' });
      }
      event.displayState.clockScale = req.body.clockScale;
      changed = true;
    }
    if (typeof req.body.screenStyle === 'string') {
      const v = req.body.screenStyle.trim();
      if (!['focus', 'wide'].includes(v)) {
        return res.status(400).json({ ok: false, error: 'Layout ecran invalid.' });
      }
      event.displayState.screenStyle = v;
      changed = true;
    }
    if (typeof req.body.displayResolution === 'string') {
      const v = req.body.displayResolution.trim();
      if (!['auto', '16-9', '16-10', '4-3'].includes(v)) {
        return res.status(400).json({ ok: false, error: 'Rezolutie ecran invalida.' });
      }
      event.displayState.displayResolution = v;
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ ok: false, error: 'Nicio schimbare specificata.' });
    }

    event.displayState.updatedAt = new Date().toISOString();
    saveDb();
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    res.json({ ok: true, displayState: event.displayState });
  });

  app.post('/api/events/:id/bible-mode', (req, res) => {
    const event = db.events[req.params.id];
    if (!event) return res.status(404).json({ ok: false, error: 'Eveniment inexistent.' });
    if (!requireEventRole(req, res, event, ['admin'])) return;
    if (!requireEventPermission(req, res, 'main_screen')) return;
    ensureEventUiState(event);

    const enabled = !!req.body.enabled;
    const wasEnabled = !!event.bibleMode;

    event.bibleMode = enabled;

    if (enabled && !wasEnabled) {
      // Activating: snapshot current display, force black screen
      rememberDisplayState(event);
      event.displayState.blackScreen = true;
      event.displayState.updatedAt = new Date().toISOString();
    } else if (!enabled && wasEnabled) {
      // Deactivating: restore previous display state if any
      if (event.displayStatePrevious) {
        const currentSnapshot = cloneDisplaySnapshot(event);
        applyDisplaySnapshot(event, event.displayStatePrevious);
        event.displayStatePrevious = currentSnapshot;
      } else {
        event.displayState.blackScreen = false;
        event.displayState.updatedAt = new Date().toISOString();
      }
    }

    recordScreenAction(event, 'display');
    saveDb();

    io.to(`event:${event.id}`).emit('bible_mode_changed', {
      enabled: event.bibleMode,
      displayState: event.displayState
    });
    io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
    emitUsageStats(event.id);

    res.json({
      ok: true,
      bibleMode: event.bibleMode,
      displayState: event.displayState,
      previousState: event.displayStatePrevious || null,
      event: normalizeEventForAccess(req, event)
    });
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
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
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
    // V21.34: open to operator (screen role with 'song' permission). Was
    // admin-only — but operators already create/load/send/push songs on this
    // list, so removing one is the natural complement. Mirrors the auth pair
    // used by every other song-library mutation in this file.
    if (!requireEventRole(req, res, event, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;

    ensureEventUiState(event);
    event.songLibrary = event.songLibrary.filter((item) => item.id !== req.params.songId);
    saveDb();
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
    res.json({ ok: true, songLibrary: event.songLibrary });
  });

  app.get('/api/global-song-library', (req, res) => {
    const library = getOrganizationSongLibrary(DEFAULT_ORG_ID);
    res.json({ ok: true, globalSongLibrary: Array.isArray(library) ? library : [], organization: buildPublicOrganization() });
  });

  // V21.14: download the whole church library as a JSON backup file.
  app.get('/api/global-song-library/export', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const library = getOrganizationSongLibrary(DEFAULT_ORG_ID) || [];
    const payload = {
      type: 'sanctuary-voice-library',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: library.length,
      songs: library
    };
    const filename = `sanctuary-voice-library-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(payload, null, 2));
  });

  // V21.14: import a library backup — MERGE (never replace). Same-title
  // songs are updated in place via upsertLibraryItem; new ones are added.
  // No existing song is deleted. NOTE: the church library is capped at
  // 100 entries (upsertLibraryItem default) — an import that would push
  // past 100 keeps the 100 most-recently-touched; `total` reports the
  // real post-import count so the caller can see if the cap was hit.
  app.post('/api/global-song-library/import', (req, res) => {
    if (!requireGlobalLibraryAdmin(req, res)) return;
    const data = req.body;
    if (!data || data.type !== 'sanctuary-voice-library' || !Array.isArray(data.songs)) {
      return res.status(400).json({ ok: false, error: 'Format invalid. Așteptat un export Sanctuary Voice.' });
    }
    const library = getOrganizationSongLibrary(DEFAULT_ORG_ID);
    if (!Array.isArray(library)) {
      return res.status(500).json({ ok: false, error: 'Biblioteca nu este disponibilă.' });
    }
    let added = 0;
    let updated = 0;
    let skipped = 0;
    data.songs.forEach((song) => {
      if (!song || !String(song.title || '').trim() || !String(song.text || '').trim()) {
        skipped++;
        return;
      }
      const norm = normalizeLibraryTitle(song.title);
      const existed = library.some((it) => it && normalizeLibraryTitle(it.title) === norm);
      upsertLibraryItem(library, {
        title: song.title,
        text: song.text,
        labels: Array.isArray(song.labels) ? song.labels : [],
        sourceLang: song.sourceLang
      });
      if (existed) updated++;
      else added++;
    });
    saveDb();
    logger.info(`[library/import] added=${added} updated=${updated} skipped=${skipped} total=${library.length}`);
    return res.json({ ok: true, added, updated, skipped, total: library.length });
  });

  app.post('/api/global-song-library', (req, res) => {
    // OPERATOR-PARITY-B — admin + operator (cu cod + eventId în body) + worship pot salva în Library.
    // (V20.3 anterior: doar admin + worship; operatorul a fost adăugat explicit cu autorizarea owner-ului.)
    if (!requireAdminOrOperatorApiSession(req, res)) return;
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
    // OPERATOR-PARITY-B — admin + operator + worship pot șterge din Library globală pinned.
    if (!requireAdminOrOperatorApiSession(req, res)) return;
    const org = getDefaultOrganization();
    org.pinnedTextLibrary = (org.pinnedTextLibrary || []).filter((item) => item.id !== req.params.itemId);
    saveDb();
    res.json({ ok: true, pinnedTextLibrary: org.pinnedTextLibrary });
  });

  app.delete('/api/global-song-library/:songId', (req, res) => {
    // OPERATOR-PARITY-B — admin + operator + worship pot șterge din Library globală.
    if (!requireAdminOrOperatorApiSession(req, res)) return;
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
    // V19: remote operators (role 'screen') with the 'song' permission may add a
    // church-library song to their event. Delete stays admin-only.
    if (!requireEventRole(req, res, adminEvent, ['admin', 'screen'])) return;
    if (!requireEventPermission(req, res, 'song')) return;

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
    // V21.6: live-sync event songLibrary across admin / operator / worship.
    io.to(`event:${event.id}`).to(`worship:${event.id}`).emit('event:songlibrary_changed', {
      eventId: event.id,
      songLibrary: event.songLibrary
    });
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
    // SEC-AUDIT-2026-06 C4: sweep earlier (was 500) so the map drains expired
    // windows before drifting large under bursty multi-IP traffic.
    if (transcribeRateLimits.size < 200) return;
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

    if (event.mode === 'song') {
      // Skip Whisper API call - operatorul afișează un cântec, transcrierea
      // audio-ului ar fi inutilă (textul rezultat ar fi oricum aruncat de
      // queueSpeechText). Răspuns identic cu cel pentru transcript gol.
      return res.json({ ok: true, skipped: 'song_mode' });
    }

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
