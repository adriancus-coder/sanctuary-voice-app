function registerSocketHandlers(io, ctx) {
  const {
    LANGUAGE_NAMES_RO,
    LANGUAGE_ENDONYMS,
    azureSpeechSessions,
    buildDisplayPayload,
    buildPublicOrganization,
    cleanupSocketPresence,
    closeAzureSpeechSession,
    db,
    emitParticipantStats,
    emitTranscriptionState,
    emitUsageStats,
    ensureEventUiState,
    getActiveSpeechProvider,
    getOrganizationForEvent,
    isEventActive,
    logger,
    normalizeEvent,
    normalizeSocketOperator,
    processText,
    recordOperatorJoin,
    recordParticipantJoin,
    recordServerError,
    recordTranscriptRefresh,
    registerParticipantSocket,
    resolveEventAccessFromCode,
    retranslateEntry,
    saveDb,
    setTranscriptionPaused,
    socketCanControlEvent,
    startAzureSpeechSession,
    ensureWorshipState,
    getWorshipSessionFromSocket,
    isWorshipAccessibleEvent,
    getWorshipViewSessionFromSocket,
    getActiveWorshipEventForView,
    buildWorshipStatePayload
  } = ctx;

  const RATE_LIMITS = {
    join_event:              { windowMs: 60 * 1000, max: 30 },
    participant_language:    { windowMs: 60 * 1000, max: 60 },
    submit_text:             { windowMs: 60 * 1000, max: 60 },
    admin_update_source:     { windowMs: 60 * 1000, max: 60 },
    set_audio_state:         { windowMs: 60 * 1000, max: 120 },
    set_transcription_state: { windowMs: 60 * 1000, max: 60 },
    end_service:             { windowMs: 60 * 1000, max: 5 },
    azure_audio_start:       { windowMs: 60 * 1000, max: 10 },
    azure_audio_chunk:       { windowMs: 1000,      max: 50 },
    azure_audio_stop:        { windowMs: 60 * 1000, max: 20 },
    'worship:view:join':     { windowMs: 60 * 1000, max: 30 },
    'worship:view:join_permanent': { windowMs: 60 * 1000, max: 30 },
    'worship:master:join':   { windowMs: 60 * 1000, max: 30 },
    'worship:master:heartbeat': { windowMs: 60 * 1000, max: 12 }
  };

  function checkSocketRateLimit(socket, eventName) {
    const limit = RATE_LIMITS[eventName];
    if (!limit) return true;
    if (!socket.data._rl) socket.data._rl = {};
    const bucket = socket.data._rl[eventName] || (socket.data._rl[eventName] = []);
    const now = Date.now();
    const cutoff = now - limit.windowMs;
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= limit.max) return false;
    bucket.push(now);
    return true;
  }

  function asString(value, maxLength = 8192) {
    if (typeof value !== 'string') return '';
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  function asEventId(value) {
    if (typeof value !== 'string') return '';
    if (value.length === 0 || value.length > 128) return '';
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
  }

  function asLanguageCode(value) {
    if (typeof value !== 'string') return '';
    return /^[a-z]{2,5}(?:-[a-z0-9]{2,8})?$/i.test(value) ? value : '';
  }

  function asBool(value) {
    return value === true;
  }

  function asNumberInRange(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function asAudioBuffer(value, maxBytes = 256 * 1024) {
    if (value == null) return null;
    let buffer = null;
    if (Buffer.isBuffer(value)) {
      buffer = value;
    } else if (value instanceof ArrayBuffer) {
      buffer = Buffer.from(value);
    } else if (ArrayBuffer.isView(value)) {
      buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else if (Array.isArray(value)) {
      if (!value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
      buffer = Buffer.from(value);
    } else {
      return null;
    }
    if (!buffer || buffer.length === 0) return null;
    if (buffer.length > maxBytes) return null;
    return buffer;
  }

  function on(socket, eventName, handler) {
    socket.on(eventName, async (...args) => {
      if (!checkSocketRateLimit(socket, eventName)) {
        socket.emit('server_error', { code: 'rate_limited', event: eventName, message: 'Too many requests.' });
        return;
      }
      try {
        await handler(...args);
      } catch (err) {
        logger.error(`socket ${eventName} handler error:`, err?.message || err);
        socket.emit('server_error', { code: 'handler_error', event: eventName, message: 'Internal error.' });
      }
    });
  }

  io.on('connection', (socket) => {
    // V21.2: read-only worship members join with a QR token (no event access
    // code). Validating the token here keeps the worship view channel separate
    // from the access-code-gated join_event flow.
    on(socket, 'worship:view:join', (payload) => {
      const eventId = asEventId(payload?.eventId);
      const token = asString(payload?.token, 128);
      if (!eventId || !token) return;
      const event = db.events[eventId];
      if (!event) {
        return socket.emit('worship:view:denied', { message: 'Evenimentul nu există.' });
      }
      const tokens = Array.isArray(event.worshipViewTokens) ? event.worshipViewTokens : [];
      if (!tokens.some((t) => t && t.token === token)) {
        return socket.emit('worship:view:denied', { message: 'Link invalid sau expirat.' });
      }
      socket.join(`worship:${eventId}`);
      socket.data.worshipViewEventId = eventId;
    });

    // V21.18: permanent-link worship view — read-only viewers authenticated by
    // the `wv:` cookie subscribe to a global room. The server pushes
    // `worship:view:live` whenever the live event's worship state changes (or
    // the live event itself flips), and `worship:view:offline` when nothing is
    // currently live. Membership in this room confers no control rights — it
    // only receives broadcasts.
    on(socket, 'worship:view:join_permanent', () => {
      const session = typeof getWorshipViewSessionFromSocket === 'function'
        ? getWorshipViewSessionFromSocket(socket)
        : null;
      if (!session) {
        return socket.emit('worship:view:permanent_denied', { message: 'Sesiune invalidă.' });
      }
      socket.join('worship-view:permanent');
      socket.data.worshipViewPermanent = true;
      const event = typeof getActiveWorshipEventForView === 'function'
        ? getActiveWorshipEventForView()
        : null;
      if (event && typeof buildWorshipStatePayload === 'function') {
        socket.emit('worship:view:live', buildWorshipStatePayload(event));
      } else {
        socket.emit('worship:view:offline');
      }
    });

    // V21.3: worship master socket — presence (offline detection) + receiving
    // operator notifications. Authenticated by the worship session cookie.
    on(socket, 'worship:master:join', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const session = getWorshipSessionFromSocket(socket);
      if (!session) {
        return socket.emit('worship:master:denied', { message: 'Sesiune worship invalidă.' });
      }
      const event = db.events[eventId];
      if (!event || !isWorshipAccessibleEvent(event)) {
        return socket.emit('worship:master:denied', { message: 'Eveniment indisponibil.' });
      }
      socket.join(`worship:${eventId}`);
      socket.data.worshipMasterEventId = eventId;
      socket.data.worshipMasterSid = session.sid || null;
      ensureWorshipState(event);
      event.worshipState.masterSessionId = session.sid || null;
      event.worshipState.masterLastSeen = Date.now();
      event.worshipState.offlineMode = false;
      saveDb();
      io.to(`worship:${eventId}`).emit('worship:master_presence', { eventId, online: true });
    });

    on(socket, 'worship:master:heartbeat', (payload) => {
      const eventId = asEventId(payload?.eventId) || socket.data.worshipMasterEventId;
      if (!eventId) return;
      const event = db.events[eventId];
      if (!event || !event.worshipState) return;
      const sid = socket.data.worshipMasterSid || null;
      // Only the tracked master refreshes presence.
      if (sid && event.worshipState.masterSessionId && sid !== event.worshipState.masterSessionId) return;
      event.worshipState.masterLastSeen = Date.now();
      if (event.worshipState.offlineMode) {
        event.worshipState.offlineMode = false;
        event.worshipState.masterSessionId = sid || event.worshipState.masterSessionId;
        saveDb();
        io.to(`worship:${eventId}`).emit('worship:master_presence', { eventId, online: true });
      }
    });

    on(socket, 'join_event', (payload) => {
      const eventId = asEventId(payload?.eventId);
      const role = asString(payload?.role, 32);
      const code = asString(payload?.code, 256);
      const language = asLanguageCode(payload?.language);
      const participantId = asString(payload?.participantId, 128);
      if (!eventId) return socket.emit('join_error', { message: 'Evenimentul nu există.' });
      const event = db.events[eventId];
      if (!event) return socket.emit('join_error', { message: 'Evenimentul nu există.' });
      const access = resolveEventAccessFromCode(event, code);
      if (role === 'admin' && access.role !== 'admin') return socket.emit('join_error', { message: 'Cod Admin invalid.' });
      if (role === 'screen' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
      if (role === 'participant_preview' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
      const supplyHasControl = ['admin', 'screen'].includes(access.role);
      const eventIsOnAir = !!event.transcriptionOnAir;
      if ((role || 'participant') === 'participant' && !isEventActive(event) && !eventIsOnAir && !supplyHasControl) {
        return socket.emit('join_error', { message: 'Evenimentul nu este live inca.' });
      }

      cleanupSocketPresence(socket);
      socket.data.eventId = eventId;
      socket.data.role = role || 'participant';
      socket.data.language = language || event.targetLangs[0] || 'no';
      socket.data.participantId = participantId || '';
      socket.data.permissions = socket.data.role === 'admin' ? ['main_screen', 'song', 'glossary'] : (access.permissions || []);

      socket.join(`event:${eventId}`);
      if (socket.data.role === 'admin') socket.join(`event:${eventId}:admins`);
      if (socket.data.role === 'screen') socket.join(`event:${eventId}:screens`);
      if (socket.data.role === 'participant' || socket.data.role === 'participant_preview') socket.join(`event:${eventId}:lang:${socket.data.language}`);
      // V21.3: operators/admins observe the worship-live channel.
      if (socket.data.role === 'admin' || socket.data.role === 'screen') socket.join(`worship:${eventId}`);

      if (socket.data.role === 'participant' && socket.data.participantId) {
        registerParticipantSocket(eventId, socket.data.participantId, socket.data.language, socket.id);
        recordParticipantJoin(event, socket.data.participantId, socket.data.language);
        saveDb();
        emitParticipantStats(eventId);
      }
      if (socket.data.role === 'admin' || socket.data.role === 'screen') {
        recordOperatorJoin(event, socket.data.role);
        saveDb();
        emitParticipantStats(eventId);
      }

      socket.emit('joined_event', {
        ok: true,
        role: socket.data.role,
        event: normalizeEvent(event, {
          includeSecrets: socket.data.role === 'admin',
          includeControlData: ['admin', 'screen'].includes(socket.data.role)
        }),
        access: socket.data.role === 'screen'
          ? { permissions: access.permissions || [], operator: normalizeSocketOperator(access.operator) }
          : null,
        languageNames: LANGUAGE_NAMES_RO,
        languageEndonyms: LANGUAGE_ENDONYMS,
        organization: buildPublicOrganization(getOrganizationForEvent(event))
      });
    });

    on(socket, 'participant_language', (payload) => {
      const targetEventId = asEventId(payload?.eventId) || socket.data.eventId;
      const language = asLanguageCode(payload?.language);
      if (!language) return;
      const oldLanguage = socket.data.language;
      if (oldLanguage && targetEventId) socket.leave(`event:${targetEventId}:lang:${oldLanguage}`);
      socket.data.language = language;
      if (targetEventId) socket.join(`event:${targetEventId}:lang:${language}`);
      if (socket.data.role === 'participant' && socket.data.participantId && targetEventId) {
        registerParticipantSocket(targetEventId, socket.data.participantId, language, socket.id);
        emitParticipantStats(targetEventId);
      }
    });

    on(socket, 'submit_text', async (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
      const event = db.events[eventId];
      if (!event) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
      if (!socketCanControlEvent(socket, eventId, 'main_screen')) {
        return socket.emit('server_error', { message: 'Nu ai permisiune pentru live text.' });
      }
      const cleanText = asString(payload?.text, 8192).trim();
      if (!cleanText) return;
      try {
        event.mode = 'live';
        await processText(event, cleanText);
      } catch (err) {
        logger.error('submit_text error:', err);
        recordServerError(event, 'Live submit translation failed.');
        saveDb();
        emitUsageStats(eventId);
        socket.emit('server_error', { message: 'Eroare la traducere.' });
      }
    });

    on(socket, 'admin_update_source', async (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const event = db.events[eventId];
      if (!event) return;
      if (!socketCanControlEvent(socket, eventId, 'main_screen')) return;
      const entryId = asString(payload?.entryId, 128);
      if (!entryId) return;
      const entry = event.transcripts.find((x) => x.id === entryId);
      if (!entry) return;
      const cleanSource = asString(payload?.sourceText, 8192).trim();
      if (!cleanSource) return;
      entry.sourceLang = event.sourceLang || 'ro';
      entry.original = cleanSource;
      entry.edited = true;
      io.to(`event:${eventId}`).emit('entry_refreshing', { entryId });
      try {
        await retranslateEntry(event, entry);
        recordTranscriptRefresh(event);
        saveDb();
        io.to(`event:${eventId}`).emit('transcript_source_updated', {
          entryId,
          sourceLang: entry.sourceLang,
          original: entry.original,
          translations: entry.translations
        });

        ensureEventUiState(event);
        emitUsageStats(eventId);
      } catch (err) {
        logger.error('admin_update_source error:', err);
        recordServerError(event, 'Source retranslation failed.');
        io.to(`event:${eventId}`).emit('entry_refresh_failed', { entryId });
        saveDb();
        emitUsageStats(eventId);
      }
    });

    on(socket, 'set_audio_state', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      if (typeof payload?.audioMuted === 'boolean') event.audioMuted = asBool(payload.audioMuted);
      if (payload?.audioVolume !== undefined) {
        const volume = asNumberInRange(payload.audioVolume, 0, 100);
        if (volume !== null) event.audioVolume = volume;
      }
      saveDb();
      io.to(`event:${eventId}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
    });

    on(socket, 'set_transcription_state', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      setTranscriptionPaused(event, asBool(payload?.paused), { markOnAir: !asBool(payload?.paused) });
    });

    on(socket, 'end_service', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      setTranscriptionPaused(event, true, { markOnAir: false });
      io.to(`event:${eventId}`).emit('service_ended', {
        eventId,
        message: 'Acest serviciu a luat sfârșit. Vă mulțumim că ați fost cu noi!',
        endedAt: new Date().toISOString()
      });
    });

    on(socket, 'azure_audio_start', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) {
        return socket.emit('server_error', { message: 'Nu ai permisiune pentru Azure Speech.' });
      }
      if (getActiveSpeechProvider() !== 'azure_sdk') {
        return socket.emit('server_error', { message: 'Azure Speech nu este activ.' });
      }
      event.mode = 'live';
      ensureEventUiState(event);
      setTranscriptionPaused(event, false, { save: false, emit: false, markOnAir: true });
      event.latestDisplayEntry = null;
      event.displayState.mode = 'auto';
      event.displayState.blackScreen = false;
      event.displayState.sceneLabel = '';
      saveDb();
      io.to(`event:${event.id}`).emit('mode_changed', { mode: 'live' });
      io.to(`event:${event.id}`).emit('display_mode_changed', buildDisplayPayload(event));
      emitTranscriptionState(event);
      startAzureSpeechSession(socket, event);
    });

    on(socket, 'azure_audio_chunk', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const session = azureSpeechSessions.get(socket.id);
      if (!session || session.eventId !== eventId || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      const buffer = asAudioBuffer(payload?.audio);
      if (buffer === null) return;
      // Skip pushing to Azure cloud during Song mode - byte-urile ar produce
      // recunoaștere care e oricum aruncată de queueSpeechText. Drop tăcut,
      // clientul nu așteaptă răspuns la chunks.
      const event = db.events[eventId];
      if (event?.mode === 'song') return;
      try {
        session.pushStream.write(buffer);
      } catch (err) {
        logger.error('azure audio chunk error:', err?.message || err);
        socket.emit('server_error', {
          provider: 'azure_sdk',
          code: 'azure_stream_failed',
          message: 'Azure Speech audio stream failed.'
        });
        closeAzureSpeechSession(socket.id);
      }
    });

    on(socket, 'azure_audio_stop', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      const session = azureSpeechSessions.get(socket.id);
      if (session?.eventId === eventId) closeAzureSpeechSession(socket.id);
      const event = db.events[eventId];
      if (event && socketCanControlEvent(socket, eventId, 'main_screen')) {
        setTranscriptionPaused(event, true);
      }
    });

    socket.on('disconnect', () => {
      closeAzureSpeechSession(socket.id);
      cleanupSocketPresence(socket);
    });
  });
}

module.exports = {
  registerSocketHandlers
};
