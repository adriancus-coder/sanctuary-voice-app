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

  // V21.21: in-memory operator presence (admin-only visibility). Volatile,
  // like participantPresence — rebuilt on restart, not persisted. Keyed by
  // eventId → Map(socketId → { name, profile, permissions, joinedAt }).
  const operatorPresence = new Map();

  function getOperatorPresence(eventId) {
    if (!operatorPresence.has(eventId)) operatorPresence.set(eventId, new Map());
    return operatorPresence.get(eventId);
  }

  function buildOperatorsPresencePayload(eventId) {
    const presence = getOperatorPresence(eventId);
    const operators = Array.from(presence.values()).map((op) => ({
      name: op.name,
      profile: op.profile,
      permissions: Array.isArray(op.permissions) ? op.permissions.slice() : []
    }));
    return { eventId, operators };
  }

  function emitOperatorsPresence(eventId) {
    if (!eventId) return;
    io.to(`event:${eventId}:admins`).emit('operators:presence', buildOperatorsPresencePayload(eventId));
  }

  // V21.21: worship-view membership = token viewers joined to
  // `worship:${eventId}` with socket.data.worshipViewEventId set, plus
  // permanent-link viewers in the global `worship-view:permanent` room
  // attributed to whichever event is currently active for worship.
  function countWorshipMembers(eventId) {
    let tokenCount = 0;
    let permanentCount = 0;
    const sockets = io.sockets.sockets;
    sockets.forEach((s) => {
      if (s.data && s.data.worshipViewEventId === eventId) tokenCount += 1;
    });
    const activeEvent = typeof getActiveWorshipEventForView === 'function'
      ? getActiveWorshipEventForView()
      : null;
    if (activeEvent && activeEvent.id === eventId) {
      sockets.forEach((s) => {
        if (s.data && s.data.worshipViewPermanent) permanentCount += 1;
      });
    }
    return {
      eventId,
      total: tokenCount + permanentCount,
      permanent: permanentCount,
      token: tokenCount
    };
  }

  function emitWorshipMembersCount(eventId) {
    if (!eventId) return;
    io.to(`worship:${eventId}`).emit('worship:members_count', countWorshipMembers(eventId));
  }

  // Permanent viewers follow whichever event is live — when membership
  // changes we always recount the active event (if any).
  function emitActiveWorshipMembersCount() {
    const activeEvent = typeof getActiveWorshipEventForView === 'function'
      ? getActiveWorshipEventForView()
      : null;
    if (activeEvent) emitWorshipMembersCount(activeEvent.id);
  }

  // WORSHIP-ROLES-ONLINE — ce roluri worship sunt conectate ACUM (din socket.data.worshipRole).
  // Rolurile sunt globale (db.worshipRoles nu-s pe eveniment), iar managementul de roluri stă în
  // tab-ul admin global → emitem către TOATE socket-urile admin (orice eveniment), nu către un room.
  function buildWorshipRolesOnline() {
    const counts = {};
    io.sockets.sockets.forEach((s) => {
      const r = s.data && s.data.worshipRole;
      if (r) counts[r] = (counts[r] || 0) + 1;
    });
    return counts;
  }
  function emitWorshipRolesOnline() {
    const payload = buildWorshipRolesOnline();
    io.sockets.sockets.forEach((s) => {
      if (s.data && s.data.role === 'admin') s.emit('worship:roles_online', payload);
    });
  }

  const RATE_LIMITS = {
    join_event:              { windowMs: 60 * 1000, max: 60 },
    participant_language:    { windowMs: 60 * 1000, max: 60 },
    submit_text:             { windowMs: 60 * 1000, max: 60 },
    admin_update_source:     { windowMs: 60 * 1000, max: 60 },
    set_audio_state:         { windowMs: 60 * 1000, max: 300 },
    set_transcription_state: { windowMs: 60 * 1000, max: 60 },
    end_service:             { windowMs: 60 * 1000, max: 5 },
    azure_audio_start:       { windowMs: 60 * 1000, max: 40 },
    azure_audio_chunk:       { windowMs: 1000,      max: 100 },
    azure_audio_stop:        { windowMs: 60 * 1000, max: 40 },
    'worship:view:join':     { windowMs: 60 * 1000, max: 30 },
    'worship:view:join_permanent': { windowMs: 60 * 1000, max: 30 },
    'worship:master:join':   { windowMs: 60 * 1000, max: 30 },
    'worship:master:heartbeat': { windowMs: 60 * 1000, max: 12 },
    // WORSHIP-LEADER: designated worship leader + hint channel.
    'worship:leader:claim':   { windowMs: 60 * 1000, max: 30 },
    'worship:leader:release': { windowMs: 60 * 1000, max: 30 },
    'worship:hint':           { windowMs: 60 * 1000, max: 60 }
  };

  // WORSHIP-LEADER: volatile designated-leader registry, eventId -> socket.id.
  // One leader per event; a fresh claim preempts the previous holder. Not
  // persisted (like operatorPresence / worshipDisconnectTimers) — leadership
  // is a live, in-the-moment role that resets cleanly on restart.
  const worshipLeaders = new Map();

  // WORSHIP-PREP-ELSEWHERE — separat de worshipLeaders: track cine (cu canAdmin) e pe ce eveniment.
  // Folosit ca să anunțăm membrii de pe ALT eveniment că „Pregătire program" e activă altundeva.
  // NU se intersectează cu logica de claim/lider — banner separat, eveniment socket separat.
  const worshipPrepPresence = new Map();   // eventId -> Set<socketId>
  function clearPrepFromOtherEvents(socketId, exceptEventId) {
    for (const [eid, set] of worshipPrepPresence.entries()) {
      if (eid !== exceptEventId && set && set.has(socketId)) {
        set.delete(socketId);
        if (!set.size) worshipPrepPresence.delete(eid);
        const ev = db.events[eid];
        io.to('worship:all').emit('worship:prep_event', {
          eventId: eid,
          eventName: ev && ev.name ? String(ev.name) : '',
          active: worshipPrepPresence.has(eid)
        });
      }
    }
  }

  // V21.20: anti-flicker grace before declaring a worship master offline on
  // socket disconnect. Browsers drop sockets on micro-net-hiccups and tab
  // switches on mobile; without a grace, we'd flap the badge. 5s is short
  // enough to feel "instant" but long enough to survive a brief reconnect.
  // The 60s WORSHIP_OFFLINE_MS heartbeat watcher remains as final fallback.
  const WORSHIP_DISCONNECT_GRACE_MS = Math.max(1000, Number(process.env.WORSHIP_DISCONNECT_GRACE_MS) || 5000);
  const worshipDisconnectTimers = new Map();

  function clearWorshipDisconnectTimer(eventId, sid) {
    if (!eventId || !sid) return;
    const key = `${eventId}:${sid}`;
    const t = worshipDisconnectTimers.get(key);
    if (t) {
      clearTimeout(t);
      worshipDisconnectTimers.delete(key);
    }
  }

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
      // V21.21: a new token viewer joined — refresh the member count.
      emitWorshipMembersCount(eventId);
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
      // V21.21: permanent viewers are attributed to the active worship
      // event — recount for that event.
      emitActiveWorshipMembersCount();
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
      // WORSHIP-LEAD-ANY-EVENT — every worship client joins one shared room so the
      // worship:leader_event broadcast targets ONLY worship clients (not io.emit
      // to every participant/screen/other-org socket). All worship clients reach
      // here because every load path runs joinMasterRoom. Auto-left on disconnect.
      socket.join('worship:all');
      // Replay the current cross-event leader state to this (possibly late-joining
      // or just-switched) client, so its "go to leader's event" banner is correct
      // even though worship:leader_event is otherwise only emitted on claim.
      for (const leadEid of worshipLeaders.keys()) {
        if (leadEid && leadEid !== eventId) {
          const lev = db.events[leadEid];
          socket.emit('worship:leader_event', { eventId: leadEid, eventName: lev && lev.name ? String(lev.name) : '', active: true });
        }
      }
      // WORSHIP-PREP-ELSEWHERE — replay și pentru prezența „Pregătire program" pe alte evenimente.
      for (const [prepEid, prepSet] of worshipPrepPresence.entries()) {
        if (prepEid && prepEid !== eventId && prepSet && prepSet.size > 0) {
          const pev = db.events[prepEid];
          socket.emit('worship:prep_event', { eventId: prepEid, eventName: pev && pev.name ? String(pev.name) : '', active: true });
        }
      }
      // WORSHIP-ROLES-3 — salvează rolul + capabilitățile pe socket pentru push țintit pe rol.
      socket.data.worshipRole = String(session.worshipRole || '');
      socket.data.worshipCanLead = !!session.canLead;
      socket.data.worshipCanAdmin = !!session.canAdmin;
      // WORSHIP-PREP-ELSEWHERE — înregistrează prezența celor cu canAdmin pe acest eveniment
      // (master: PIN-global are canAdmin=true din session; intenția cerută = „Pregătire program" =
      //  rol cu canAdmin. Dacă vrei să excluzi master, adaugă && !session.worshipMaster.)
      if (session.canAdmin) {
        clearPrepFromOtherEvents(socket.id, eventId);   // socketul s-a mutat aici dintr-un alt eveniment
        if (!worshipPrepPresence.has(eventId)) worshipPrepPresence.set(eventId, new Set());
        worshipPrepPresence.get(eventId).add(socket.id);
        const ev = db.events[eventId];
        io.to('worship:all').emit('worship:prep_event', {
          eventId,
          eventName: ev && ev.name ? String(ev.name) : '',
          active: true
        });
      }
      // WORSHIP-ROLES-SYNC — capabilități adiționale pentru filtrarea worship:roles_changed.
      socket.data.worshipCanManageRoles = !!session.canManageRoles;
      socket.data.worshipMaster = !!session.worshipMaster;
      // WORSHIP-ROLES-ONLINE — anunță adminii că un rol s-a conectat (dacă sesiunea are rol).
      if (socket.data.worshipRole) emitWorshipRolesOnline();
      ensureWorshipState(event);
      event.worshipState.masterSessionId = session.sid || null;
      event.worshipState.masterLastSeen = Date.now();
      event.worshipState.offlineMode = false;
      // V21.20: a fresh master:join after a brief disconnect must cancel any
      // pending offline-grace timer so the badge doesn't flap.
      clearWorshipDisconnectTimer(eventId, session.sid || null);
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

    // WORSHIP-LEADER: a worship master claims the designated-leader slot for an
    // event. Auth mirrors worship:master:join (valid worship session + worship-
    // accessible event). A fresh claim preempts any previous leader; the
    // `worship:leader` broadcast is the single source of truth the clients use
    // to decide who is leader, so we never optimistically set it on the client.
    on(socket, 'worship:leader:claim', (payload) => {
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
      // WORSHIP-ROLES-LIVE — re-verifică rolul CURENT din db.worshipRoles (scoaterea capabilității
      // are efect imediat, nu doar la următorul login).
      // WORSHIP-PIN-MASTER — maestrul (PIN global) trece peste verificarea db (nu-i găsit acolo).
      if (!session.worshipMaster) {
        const _claimRole = session.worshipRole || '';
        if (_claimRole) {
          const _ro = (Array.isArray(db.worshipRoles) ? db.worshipRoles : []).find((r) => r.name === _claimRole);
          if (!_ro || !_ro.canLead) {
            return socket.emit('worship:master:denied', { message: 'Rolul tău nu mai poate fi lider.' });
          }
        }
      }
      // Ensure room membership so this claimant also receives the broadcast
      // below (a master that toggled into Live mode is already joined, but a
      // claim from any other state must not silently miss its own confirmation).
      socket.join(`worship:${eventId}`);
      worshipLeaders.set(eventId, socket.id);
      socket.data.worshipLeaderEventId = eventId;
      io.to(`worship:${eventId}`).emit('worship:leader', { eventId, leaderId: socket.id, active: true });
      // WORSHIP-LEAD-ANY-EVENT — anunță userii worship (camera worship:all) că există
      // un lider pe acest eveniment, ca cei de pe alt eveniment să afișeze banner-ul
      // „Liderul conduce pe alt eveniment". Scoped la worship:all (nu io.emit), ca
      // participanții/proiectoarele/alte organizații să nu primească intern worship.
      io.to('worship:all').emit('worship:leader_event', {
        eventId,
        eventName: event && event.name ? String(event.name) : '',
        active: true
      });
    });

    // WORSHIP-LEADER: the current leader releases the slot. Only the holder can
    // release (guards against a stale ex-leader clearing the active one).
    on(socket, 'worship:leader:release', (payload) => {
      const eventId = asEventId(payload?.eventId) || socket.data.worshipLeaderEventId;
      if (!eventId) return;
      if (worshipLeaders.get(eventId) === socket.id) {
        worshipLeaders.delete(eventId);
        if (socket.data.worshipLeaderEventId === eventId) socket.data.worshipLeaderEventId = '';
        io.to(`worship:${eventId}`).emit('worship:leader', { eventId, leaderId: null, active: false });
        // WORSHIP-LEAD-ANY-EVENT — anunță userii worship că liderul a renunțat (ascunde banner-ul).
        io.to('worship:all').emit('worship:leader_event', { eventId, eventName: '', active: false });
      }
    });

    // WORSHIP-LEADER: only the designated leader may emit hints. Hints are
    // banner-only signals — the actual live action (verse/song change) travels
    // the existing POST /verse + changeLiveSong path on the client, so this
    // handler never touches worshipState. Fan out to the event room (members,
    // master, token projectors, operators) and the permanent-projector room.
    on(socket, 'worship:hint', (payload) => {
      const eventId = asEventId(payload?.eventId);
      if (!eventId) return;
      // WORSHIP-NOTES-FIX — type 'note' e permis de la ORICE worship master (admin non-lider);
      // restul hinturilor rămân exclusiv pentru lider (gating existent).
      const isNote = payload?.type === 'note';
      if (!isNote && worshipLeaders.get(eventId) !== socket.id) return; // only the leader for non-note hints
      // WORSHIP-ROLES-LIVE — pentru type 'note': re-verifică rolul CURENT din db.worshipRoles
      // (scoaterea capabilității canAdmin are efect imediat).
      // WORSHIP-PIN-MASTER — maestrul (PIN global) trece peste verificarea db.
      if (isNote) {
        const _ns = getWorshipSessionFromSocket(socket);
        if (!_ns?.worshipMaster) {
          const _nRole = _ns?.worshipRole || '';
          if (_nRole) {
            const _nro = (Array.isArray(db.worshipRoles) ? db.worshipRoles : []).find((r) => r.name === _nRole);
            if (!_nro || !_nro.canAdmin) return; // rol fără worship-admin → nota nu se trimite
          }
        }
      }
      // WORSHIP-NOTES-FIX + earlier — extins HINT_TYPES cu types existente în client
      // (note/countdown/transpose) care erau silent-dropped înainte.
      const HINT_TYPES = ['repeat', 'repeat_chorus', 'next', 'chorus', 'jump_verse', 'change_key', 'jump_song', 'free', 'note', 'countdown', 'transpose'];
      const type = HINT_TYPES.includes(payload?.type) ? payload.type : null;
      if (!type) return;
      const hint = { type, eventId, ts: Date.now() };
      const text = asString(payload?.text, 200).trim();
      if (text) hint.text = text;
      if (type === 'jump_verse') {
        const vi = asNumberInRange(payload?.verseIndex, 0, 9999);
        hint.verseIndex = vi == null ? 0 : Math.round(vi);
      }
      if (type === 'change_key') hint.key = asString(payload?.key, 16).trim();
      if (type === 'jump_song') hint.songId = asString(payload?.songId, 128);
      io.to(`worship:${eventId}`).to('worship-view:permanent').emit('worship:hint', hint);
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
      if (socket.data.role === 'admin') {
        socket.join(`event:${eventId}:admins`);
        // SEC-AUDIT-2026-06 A1: global admin room for org-level notifications
        // (access_request_created) that must not reach participants.
        socket.join('admins');
      }
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
      // V21.21: track screen operators in volatile presence so admins can
      // see who's connected. Admins are NOT tracked here — only `screen`
      // role (admins join with socket.data.role === 'admin').
      //
      // V21.21-FIX2: dropped the `&& access.operator` guard. resolveEventAccess-
      // FromCode populates `operator` for the named/main-operator/master-mod
      // paths, but the user reported that MAIN_OPERATOR_PIN logins weren't
      // tracked while named operators were — i.e. some live path was reaching
      // here with role='screen' but operator=null (e.g. admin code supplied
      // via /remote yields access.role='admin' + operator=null while
      // socket.data.role stays 'screen'). Now we track every screen-role
      // socket and build a fallback identity from whatever access carries.
      if (socket.data.role === 'screen') {
        const op = access.operator;
        const fallbackName = access.role === 'admin' ? 'Administrator' : 'Operator principal';
        const presence = getOperatorPresence(eventId);
        presence.set(socket.id, {
          name: (op && op.name) || fallbackName,
          profile: (op && op.profile) || 'full',
          permissions: Array.isArray(access.permissions) ? access.permissions.slice() : [],
          joinedAt: Date.now()
        });
        socket.data.operatorPresenceEventId = eventId;
        emitOperatorsPresence(eventId);
        logger.info(`[operator/presence] join event=${eventId} socket=${socket.id} accessRole=${access.role} opId=${op && op.id || '-'} name="${(op && op.name) || fallbackName}"`);
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

      // V21.21-FIX: snapshots must be emitted AFTER joined_event. The admin
      // client's joined_event handler resets adminOperatorsPresence and
      // adminWorshipMembers to a clean slate before re-rendering; when the
      // snapshots arrived first they were promptly wiped, so the admin saw
      // 'Niciun operator conectat' even with operators connected. Tracking,
      // broadcast, listener — all worked; only the order was wrong.
      if (socket.data.role === 'admin') {
        socket.emit('operators:presence', buildOperatorsPresencePayload(eventId));
        socket.emit('worship:members_count', countWorshipMembers(eventId));
      }
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
      startAzureSpeechSession(socket, event).catch((err) => {
        socket.emit('server_error', { provider: 'azure_sdk', code: 'azure_start_failed',
          message: 'Nu am putut porni Azure Speech.', fallbackToOpenAI: true });
      });
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
      // WORSHIP-ROLES-ONLINE — dacă socketul avea un rol worship, recoutează după
      // ce socket-ul iese din io.sockets.sockets (setTimeout 0 = next tick).
      const hadWorshipRole = !!(socket.data && socket.data.worshipRole);
      if (hadWorshipRole) setTimeout(emitWorshipRolesOnline, 0);
      // V21.21: drop this socket from operator presence + worship member
      // tracking and broadcast fresh counts. Happens BEFORE the worship
      // master grace handler so admins see operator leaves immediately.
      const opEventId = socket.data && socket.data.operatorPresenceEventId;
      if (opEventId) {
        const presence = getOperatorPresence(opEventId);
        if (presence.delete(socket.id)) emitOperatorsPresence(opEventId);
        if (presence.size === 0) operatorPresence.delete(opEventId);
      }
      // Clear the flags first — the disconnecting socket is still in
      // io.sockets.sockets when the disconnect handler runs, so the
      // recount must not see itself.
      const wvTokenEventId = socket.data && socket.data.worshipViewEventId;
      const wasPermanent = !!(socket.data && socket.data.worshipViewPermanent);
      if (socket.data) {
        socket.data.worshipViewEventId = '';
        socket.data.worshipViewPermanent = false;
      }
      if (wvTokenEventId) emitWorshipMembersCount(wvTokenEventId);
      if (wasPermanent) emitActiveWorshipMembersCount();
      // V21.20: if this socket was the tracked worship master, start a short
      // grace timer instead of waiting ~60s for the heartbeat watcher. On
      // expiry, only mark offline + broadcast if the master hasn't reclaimed
      // its slot (sid still matches). Uses the SAME channel as online.
      const wEventId = socket.data.worshipMasterEventId;
      const wSid = socket.data.worshipMasterSid;
      if (wEventId && wSid) {
        const event = db.events[wEventId];
        if (event && event.worshipState && event.worshipState.masterSessionId === wSid) {
          clearWorshipDisconnectTimer(wEventId, wSid);
          const key = `${wEventId}:${wSid}`;
          const timer = setTimeout(() => {
            worshipDisconnectTimers.delete(key);
            const ev = db.events[wEventId];
            const ws = ev && ev.worshipState;
            if (!ws || ws.masterSessionId !== wSid) return;
            ws.offlineMode = true;
            ws.masterSessionId = null;
            saveDb();
            io.to(`worship:${wEventId}`).emit('worship:master_presence', { eventId: wEventId, online: false });
            logger.info(`[worship/offline] master disconnect grace expired event=${wEventId}`);
          }, WORSHIP_DISCONNECT_GRACE_MS);
          worshipDisconnectTimers.set(key, timer);
        }
      }
      // WORSHIP-LEADER: release the leader slot immediately on disconnect (no
      // grace — leadership is an active, hands-on role). Only clear it if this
      // socket still holds it, so a preempted ex-leader can't drop the current.
      const leaderEventId = socket.data && socket.data.worshipLeaderEventId;
      if (leaderEventId && worshipLeaders.get(leaderEventId) === socket.id) {
        worshipLeaders.delete(leaderEventId);
        io.to(`worship:${leaderEventId}`).emit('worship:leader', { eventId: leaderEventId, leaderId: null, active: false });
        // WORSHIP-LEAD-ANY-EVENT — anunță userii worship că liderul s-a deconectat.
        io.to('worship:all').emit('worship:leader_event', { eventId: leaderEventId, eventName: '', active: false });
      }
      // WORSHIP-PREP-ELSEWHERE — curăță prezența „Pregătire program" la deconectare; banner se ascunde
      // pe ceilalți dacă era ultimul canAdmin pe evenimentul respectiv.
      for (const [eid, set] of worshipPrepPresence.entries()) {
        if (set && set.has(socket.id)) {
          set.delete(socket.id);
          const stillActive = set.size > 0;
          if (!stillActive) worshipPrepPresence.delete(eid);
          const ev = db.events[eid];
          io.to('worship:all').emit('worship:prep_event', {
            eventId: eid,
            eventName: ev && ev.name ? String(ev.name) : '',
            active: stillActive
          });
        }
      }
      cleanupSocketPresence(socket);
    });
  });
}

module.exports = {
  registerSocketHandlers
};
