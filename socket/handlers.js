function registerSocketHandlers(io, ctx) {
  const {
    LANGUAGE_NAMES_RO,
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
    startAzureSpeechSession
  } = ctx;

  io.on('connection', (socket) => {
    socket.on('join_event', ({ eventId, role, code, language, participantId }) => {
      const event = db.events[eventId];
      if (!event) return socket.emit('join_error', { message: 'Evenimentul nu există.' });
      const access = resolveEventAccessFromCode(event, code);
      if (role === 'admin' && access.role !== 'admin') return socket.emit('join_error', { message: 'Cod Admin invalid.' });
      if (role === 'screen' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
      if (role === 'participant_preview' && !['admin', 'screen'].includes(access.role)) return socket.emit('join_error', { message: 'Cod operator invalid.' });
      if ((role || 'participant') === 'participant' && !isEventActive(event)) {
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
        organization: buildPublicOrganization(getOrganizationForEvent(event))
      });
    });

    socket.on('participant_language', ({ eventId, language }) => {
      const targetEventId = eventId || socket.data.eventId;
      const oldLanguage = socket.data.language;
      if (oldLanguage && targetEventId) socket.leave(`event:${targetEventId}:lang:${oldLanguage}`);
      socket.data.language = language;
      if (targetEventId) socket.join(`event:${targetEventId}:lang:${language}`);
      if (socket.data.role === 'participant' && socket.data.participantId && targetEventId) {
        registerParticipantSocket(targetEventId, socket.data.participantId, language, socket.id);
        emitParticipantStats(targetEventId);
      }
    });

    socket.on('submit_text', async ({ eventId, text }) => {
      const event = db.events[eventId];
      if (!event) return socket.emit('server_error', { message: 'Eveniment inexistent.' });
      if (!socketCanControlEvent(socket, eventId, 'main_screen')) {
        return socket.emit('server_error', { message: 'Nu ai permisiune pentru live text.' });
      }
      const cleanText = String(text || '').trim();
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

    socket.on('admin_update_source', async ({ eventId, entryId, sourceText }) => {
      const event = db.events[eventId];
      if (!event) return;
      if (!socketCanControlEvent(socket, eventId, 'main_screen')) return;
      const entry = event.transcripts.find((x) => x.id === entryId);
      if (!entry) return;
      const cleanSource = String(sourceText || '').trim();
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

    socket.on('set_audio_state', ({ eventId, audioMuted, audioVolume }) => {
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      if (typeof audioMuted === 'boolean') event.audioMuted = audioMuted;
      if (typeof audioVolume === 'number') event.audioVolume = Math.max(0, Math.min(100, audioVolume));
      saveDb();
      io.to(`event:${eventId}`).emit('audio_state', { audioMuted: event.audioMuted, audioVolume: event.audioVolume });
    });

    socket.on('set_transcription_state', ({ eventId, paused }) => {
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      setTranscriptionPaused(event, !!paused, { markOnAir: !paused });
    });

    socket.on('end_service', ({ eventId }) => {
      const event = db.events[eventId];
      if (!event || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      setTranscriptionPaused(event, true, { markOnAir: false });
      io.to(`event:${eventId}`).emit('service_ended', {
        eventId,
        message: 'Acest serviciu a luat sfârșit. Vă mulțumim că ați fost cu noi!',
        endedAt: new Date().toISOString()
      });
    });

    socket.on('azure_audio_start', ({ eventId }) => {
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

    socket.on('azure_audio_chunk', ({ eventId, audio }) => {
      const session = azureSpeechSessions.get(socket.id);
      if (!session || session.eventId !== eventId || !socketCanControlEvent(socket, eventId, 'main_screen')) return;
      const buffer = Buffer.from(audio || []);
      if (!buffer.length) return;
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

    socket.on('azure_audio_stop', ({ eventId }) => {
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
