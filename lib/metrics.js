'use strict';

// SV-LATENCY-METRICS — per-segment pipeline timings (recognition, translation,
// delivery). Pure observation: recording never changes what is emitted to
// participants/screens. The last 200 segments are kept in memory; a JSON line
// per segment is appended to LOG_DIR only when enabled (TRANSLATION_MONITOR_ENABLED=1).
const fs = require('fs');
const path = require('path');

function createMetrics({ logDir, enabled = false, logger = console, max = 200 } = {}) {
  const segments = [];                 // ring buffer of recorded segments (newest last)
  const lastRecognition = new Map();   // eventId -> { recognitionLatencyMs, at }
  let stream = null;

  function ensureStream() {
    if (!enabled) return null;
    if (stream) return stream;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      stream = fs.createWriteStream(path.join(logDir, 'translation-metrics.log'), { flags: 'a' });
    } catch (err) {
      if (logger && logger.warn) logger.warn('metrics log open failed:', err && err.message);
    }
    return stream;
  }

  // Called from the recognition path (Azure `recognized` / OpenAI transcribe) so
  // the next published segment can attribute a recognition latency to itself.
  function noteRecognition(eventId, info) {
    if (!eventId) return;
    lastRecognition.set(String(eventId), {
      recognitionLatencyMs: Number(info && info.recognitionLatencyMs) || null,
      at: Number(info && info.at) || Date.now()
    });
  }
  function takeRecognition(eventId) {
    const key = String(eventId);
    const v = lastRecognition.get(key) || null;
    lastRecognition.delete(key);
    return v;
  }

  function record(seg) {
    const rec = { ts: new Date().toISOString(), ...seg };
    segments.push(rec);
    if (segments.length > max) segments.shift();
    if (enabled) {
      const s = ensureStream();
      if (s) { try { s.write(JSON.stringify(rec) + '\n'); } catch { /* best effort */ } }
    }
    return rec;
  }

  function recentForEvent(eventId, n = 50) {
    const key = String(eventId);
    const out = [];
    for (let i = segments.length - 1; i >= 0 && out.length < n; i -= 1) {
      if (segments[i].eventId === key) out.push(segments[i]);
    }
    return out.reverse();
  }

  function percentile(arr, p) {
    const xs = arr.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
    return xs[idx];
  }

  function summarize(records) {
    const pick = (key) => records.map((r) => r[key]).filter((x) => typeof x === 'number');
    const stat = (a) => ({ median: percentile(a, 50), p90: percentile(a, 90) });
    return {
      count: records.length,
      recognition: stat(pick('recognitionMs')),
      translate: stat(pick('translateMs')),
      total: stat(pick('totalMs')),
      model: records.length ? records[records.length - 1].model : null
    };
  }

  function summaryForEvent(eventId, n = 50) {
    return summarize(recentForEvent(eventId, n));
  }

  return { noteRecognition, takeRecognition, record, recentForEvent, summarize, summaryForEvent };
}

module.exports = { createMetrics };
