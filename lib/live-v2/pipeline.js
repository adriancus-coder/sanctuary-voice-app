'use strict';

// LIVE-V2-PIPELINE — orchestrates the v2 live engine for one process. It holds
// per-event runtime state (a segmenter + an ordered commit queue + provisional
// streaming) and turns Azure recognition events into:
//
//   - `live_v2_commit`     — a committed clause, translated per language, in
//                            strict per-language order (a later clause is never
//                            emitted before an earlier one).
//   - `live_v2_provisional`— the uncommitted tail, translated on a throttle and
//                            streamed, aborted the moment its clause commits.
//   - `transcript_entry`   — each committed clause saved in the legacy entry
//                            shape so history/export/admin keep working.
//   - bridge translation.final / translation.partial — unchanged contract.
//
// It deliberately does NOT emit `display_live_entry` / `display_live_entry_partial`
// so the projector (translate.html) never shows v2 live text.
//
// All I/O is injected so the module stays decoupled from server.js. Legacy
// events never reach here — the caller gates on the per-event engine.

const { createSegmenter } = require('./segmenter');

const PROVISIONAL_MIN_INTERVAL_MS = 1200; // at most ~1 provisional translate / 1.2s
const PROVISIONAL_MIN_NEW_WORDS = 8;      // ...unless 8+ new words arrived sooner
const PARTIAL_EMIT_THROTTLE_MS = 120;     // per-language provisional delta emit
const PARAGRAPH_MAX_WORDS = 40;           // a sentence end past this starts a new ¶
const PARAGRAPH_PAUSE_MS = 3000;          // a gap longer than this starts a new ¶
const TRANSCRIPT_CAP = 300;

function createLiveV2Pipeline(deps) {
  const {
    io,
    logger,
    translateClauseV2,     // (event, lang, clause, opts) -> Promise<string>
    sanitizeTranscriptText,
    countWords,
    cloneDisplayEntry,
    randomUUID,
    saveDb,
    emitBridgeTranslation, // (eventId, name, payload)
    recordSegmentLatency,  // (event, {...}) — reuses the legacy metrics path
    afterCommit,           // (event, entry) — monitor/usage refresh
    now = () => Date.now()
  } = deps;

  const states = new Map(); // eventId -> state

  function ensureState(event, sourceLang) {
    let s = states.get(event.id);
    if (s && s.sourceLang === sourceLang) return s;
    if (s) teardown(s);
    s = {
      eventId: event.id,
      sourceLang,
      segmenter: createSegmenter({ sourceLang }),
      seq: 0,
      queue: [],
      draining: false,
      committedContext: [],      // last 2 committed { source, translations }
      paragraphId: randomUUID(),
      paragraphWords: 0,
      lastCommitAt: 0,
      pendingNewParagraph: false,
      provAbort: null,
      provLastAt: 0,
      provLastWords: 0
    };
    states.set(event.id, s);
    return s;
  }

  function teardown(s) {
    abortProvisional(s);
    s.queue.length = 0;
  }

  function abortProvisional(s) {
    if (s.provAbort) {
      try { s.provAbort.abort(); } catch { /* already aborted */ }
      s.provAbort = null;
    }
  }

  function newParagraph(s) {
    s.paragraphId = randomUUID();
    s.paragraphWords = 0;
  }

  function ctxFor(s, lang) {
    return s.committedContext
      .map((c) => ({ source: c.source, translation: c.translations ? c.translations[lang] : '' }))
      .filter((c) => c.translation);
  }

  // ---- commit path (ordered) --------------------------------------------------

  function enqueueCommit(event, s, commit) {
    s.seq += 1;
    s.queue.push({ seq: s.seq, text: commit.text, endsSentence: commit.endsSentence, words: commit.words });
    drain(event, s);
  }

  async function drain(event, s) {
    if (s.draining) return;
    s.draining = true;
    try {
      while (s.queue.length) {
        const item = s.queue.shift();
        // The event may have been reconfigured/closed while queued.
        if (!states.has(event.id)) break;
        try {
          await processCommit(event, s, item);
        } catch (err) {
          logger && logger.error && logger.error('[live-v2] commit failed:', err && (err.message || err));
        }
      }
    } finally {
      s.draining = false;
    }
  }

  async function processCommit(event, s, item) {
    const t = now();
    // Paragraph boundaries: a long pause, or a flagged sentence-end past the cap.
    if (s.lastCommitAt && t - s.lastCommitAt > PARAGRAPH_PAUSE_MS) newParagraph(s);
    if (s.pendingNewParagraph) { newParagraph(s); s.pendingNewParagraph = false; }
    const paragraphId = s.paragraphId;

    const targetLangs = Array.isArray(event.targetLangs) ? event.targetLangs : [];
    const perLangMs = {};
    const translateStartedAt = Date.now();
    const translations = {};
    await Promise.all(targetLangs.map(async (lang) => {
      const langStart = Date.now();
      const out = await translateClauseV2(event, lang, item.text, {
        sourceLang: s.sourceLang,
        endsSentence: item.endsSentence,
        contextClauses: ctxFor(s, lang)
      });
      perLangMs[lang] = Date.now() - langStart;
      translations[lang] = out;
    }));
    const translateFinishedAt = Date.now();

    const createdAt = new Date().toISOString();
    const entry = {
      id: randomUUID(),
      sourceLang: s.sourceLang,
      original: item.text,
      translations,
      createdAt,
      edited: false
    };

    // Save into transcripts (legacy shape) so history / export keep working.
    event.transcripts = Array.isArray(event.transcripts) ? event.transcripts : [];
    event.transcripts.push(entry);
    if (event.transcripts.length > TRANSCRIPT_CAP) event.transcripts = event.transcripts.slice(-TRANSCRIPT_CAP);
    event.latestDisplayEntry = cloneDisplayEntry(entry);

    // Fan out. transcript_entry feeds admin + participant history; live_v2_commit
    // drives the participant flowing subtitle; the bridge gets the final entry.
    io.to(`event:${event.id}`).emit('transcript_entry', entry);
    io.to(`event:${event.id}`).emit('live_v2_commit', {
      eventId: event.id,
      seq: item.seq,
      paragraphId,
      source: item.text,
      translations,
      endsSentence: !!item.endsSentence,
      createdAt
    });
    emitBridgeTranslation(event.id, 'translation.final', entry);

    // Context for the next clause's prompt (last 2).
    s.committedContext.push({ source: item.text, translations });
    if (s.committedContext.length > 2) s.committedContext = s.committedContext.slice(-2);

    // Paragraph accounting: a sentence end past the cap starts the next ¶.
    s.paragraphWords += item.words;
    if (item.endsSentence && s.paragraphWords >= PARAGRAPH_MAX_WORDS) s.pendingNewParagraph = true;
    s.lastCommitAt = now();

    // Metrics (per clause) + monitor/usage refresh, then persist.
    try {
      recordSegmentLatency(event, {
        entryId: entry.id,
        sourceLang: s.sourceLang,
        perLangMs,
        translateStartedAt,
        translateFinishedAt,
        deliveredAt: Date.now(),
        modelLabel: 'live-v2'
      });
    } catch { /* metrics are best-effort */ }
    try { afterCommit(event, entry); } catch { /* monitor refresh best-effort */ }
    saveDb();
  }

  // ---- provisional path (throttled, streamed, abortable) ----------------------

  function maybeProvisional(event, s, provisionalText) {
    const prov = sanitizeTranscriptText(provisionalText || '');
    if (!prov) { abortProvisional(s); return; }
    const wc = countWords(prov);
    const t = now();
    const newWords = wc - s.provLastWords;
    if (s.provAbort && t - s.provLastAt < PROVISIONAL_MIN_INTERVAL_MS && newWords < PROVISIONAL_MIN_NEW_WORDS) {
      return; // throttle: keep the in-flight provisional
    }
    startProvisional(event, s, prov, wc, t);
  }

  function startProvisional(event, s, prov, wc, t) {
    abortProvisional(s);
    const abort = (typeof AbortController === 'function') ? new AbortController() : null;
    s.provAbort = abort;
    s.provLastAt = t;
    s.provLastWords = wc;

    const seq = s.seq; // provisional sits after this many committed clauses
    const paragraphId = s.paragraphId;
    const translations = {};
    const lastEmit = new Map();
    const targetLangs = Array.isArray(event.targetLangs) ? event.targetLangs : [];

    const emit = () => {
      io.to(`event:${event.id}`).emit('live_v2_provisional', {
        eventId: event.id,
        seq,
        paragraphId,
        source: prov,
        translations: { ...translations }
      });
      emitBridgeTranslation(event.id, 'translation.partial', {
        entryId: `v2-prov-${seq}`,
        sourceLang: s.sourceLang,
        original: prov,
        createdAt: new Date().toISOString(),
        partial: true,
        translations: { ...translations }
      });
    };

    // Emit once immediately so source-language viewers see the tail without
    // waiting on a translation round-trip.
    emit();

    targetLangs.forEach((lang) => {
      translateClauseV2(event, lang, prov, {
        sourceLang: s.sourceLang,
        endsSentence: false,
        provisional: true,
        contextClauses: ctxFor(s, lang),
        signal: abort ? abort.signal : null,
        onDelta: (full) => {
          if (abort && abort.signal.aborted) return;
          translations[lang] = full;
          const n = now();
          const last = lastEmit.get(lang) || 0;
          if (n - last < PARTIAL_EMIT_THROTTLE_MS) return;
          lastEmit.set(lang, n);
          emit();
        }
      }).then((finalText) => {
        if (abort && abort.signal.aborted) return;
        if (finalText) { translations[lang] = finalText; emit(); }
      }).catch(() => { /* provisional is best-effort */ });
    });
  }

  // ---- public surface ---------------------------------------------------------

  function onPartial(event, text, sourceLang) {
    const clean = sanitizeTranscriptText(text || '');
    if (!clean) return;
    const s = ensureState(event, sourceLang);
    const r = s.segmenter.pushPartial(clean);
    for (const commit of r.commits) enqueueCommit(event, s, commit);
    // A commit may have superseded the provisional; recompute from the new tail.
    if (r.commits.length) abortProvisional(s);
    maybeProvisional(event, s, r.provisional);
  }

  function onFinal(event, text, sourceLang) {
    const clean = sanitizeTranscriptText(text || '');
    const s = ensureState(event, sourceLang);
    abortProvisional(s); // the final commit supersedes any in-flight provisional
    const r = s.segmenter.pushFinal(clean);
    for (const commit of r.commits) enqueueCommit(event, s, commit);
  }

  function closeEvent(eventId) {
    const s = states.get(eventId);
    if (!s) return;
    teardown(s);
    states.delete(eventId);
  }

  function activeEventIds() {
    return Array.from(states.keys());
  }

  return { onPartial, onFinal, closeEvent, activeEventIds };
}

module.exports = { createLiveV2Pipeline };
