// SV-LATENCY-METRICS tests — the in-memory ring buffer, percentiles, per-event
// summary, and recognition hand-off. No server, no network. Exit 0/1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMetrics } = require('../lib/metrics');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

test('records segments and keeps only the last `max`', () => {
  const m = createMetrics({ enabled: false, max: 3 });
  for (let i = 0; i < 5; i++) m.record({ eventId: 'e1', translateMs: i, totalMs: i, recognitionMs: i });
  const recent = m.recentForEvent('e1', 50);
  assert.strictEqual(recent.length, 3, 'ring buffer capped at max');
  assert.deepStrictEqual(recent.map((r) => r.translateMs), [2, 3, 4], 'keeps newest');
});

test('recentForEvent filters by event and orders oldest->newest', () => {
  const m = createMetrics({ enabled: false });
  m.record({ eventId: 'a', translateMs: 1 });
  m.record({ eventId: 'b', translateMs: 99 });
  m.record({ eventId: 'a', translateMs: 2 });
  const a = m.recentForEvent('a', 50);
  assert.deepStrictEqual(a.map((r) => r.translateMs), [1, 2]);
  assert.strictEqual(m.recentForEvent('b', 50).length, 1);
});

test('summarize computes median and p90', () => {
  const m = createMetrics({ enabled: false });
  [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].forEach((v) =>
    m.record({ eventId: 'e', recognitionMs: v, translateMs: v, totalMs: v, model: 'gpt-4.1-nano' }));
  const s = m.summaryForEvent('e', 50);
  assert.strictEqual(s.count, 10);
  assert.strictEqual(s.total.median, 500, 'median (ceil(0.5*10)=5th value)');
  assert.strictEqual(s.total.p90, 900, 'p90 (ceil(0.9*10)=9th value)');
  assert.strictEqual(s.model, 'gpt-4.1-nano', 'last model reported');
});

test('summary is null-safe with no data', () => {
  const m = createMetrics({ enabled: false });
  const s = m.summaryForEvent('none', 50);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.total.median, null);
});

test('noteRecognition / takeRecognition hands off once', () => {
  const m = createMetrics({ enabled: false });
  m.noteRecognition('e', { recognitionLatencyMs: 42, at: 123 });
  const r = m.takeRecognition('e');
  assert.strictEqual(r.recognitionLatencyMs, 42);
  assert.strictEqual(r.at, 123);
  assert.strictEqual(m.takeRecognition('e'), null, 'consumed after take');
});

test('writes JSON lines to LOG_DIR only when enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-'));
  const m = createMetrics({ enabled: true, logDir: dir });
  m.record({ eventId: 'e', translateMs: 5, totalMs: 6, recognitionMs: 1 });
  const file = path.join(dir, 'translation-metrics.log');
  // createWriteStream flushes async; give it a tick.
  const done = () => {
    const line = fs.readFileSync(file, 'utf8').trim().split('\n')[0];
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.eventId, 'e');
    assert.ok(parsed.ts, 'timestamped');
  };
  // Synchronous-enough: the stream write lands before process exit; verify via a short spin.
  const deadline = Date.now() + 1000;
  (function spin() {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return done();
    if (Date.now() > deadline) throw new Error('log line not written');
    setTimeout(spin, 20);
  })();
});

setTimeout(() => {
  if (failures) { console.error(`\nmetrics tests: ${failures} failure(s)`); process.exit(1); }
  console.log('\nmetrics tests passed');
}, 1200);
