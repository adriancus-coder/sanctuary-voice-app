// SV-BENCH test — the bench runs on a fixture with a mocked recogniser (a
// transcript) and no API key, and produces a well-formed report. Also checks the
// gpt5-nano config records reasoning effort. No network. Exit 0/1.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

const bench = path.join(__dirname, 'bench.js');
const fixture = path.join(__dirname, 'fixtures', 'bench-sample.txt');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));

function run(config) {
  const out = path.join(tmp, `report-${config}.json`);
  execFileSync(process.execPath, [bench, '--transcript', fixture, '--config', config, '--out', out],
    { env: { ...process.env, OPENAI_API_KEY: '' }, stdio: 'ignore' });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('current config produces a report with per-target latency + pairs', () => {
  const r = run('current');
  assert.strictEqual(r.config, 'current');
  assert.strictEqual(r.mocked, true, 'runs in mock mode without a key');
  assert.strictEqual(r.segments, 4, 'four fixture segments');
  assert.ok(r.latencyMs && r.latencyMs.translationByTarget.en, 'EN latency present');
  assert.ok(r.latencyMs.translationByTarget.no, 'NO latency present');
  assert.strictEqual(r.pairs.length, 4, 'source/translation pairs for each segment');
  assert.ok(r.pairs[0].targets.en && typeof r.pairs[0].targets.en.text === 'string', 'pair has EN translation text');
  assert.ok(typeof r.tokens.total === 'number' && typeof r.costEstimateUsd === 'number', 'tokens + cost estimate');
});

test('gpt5-nano config records reasoning effort minimal', () => {
  const r = run('gpt5-nano');
  assert.strictEqual(r.model, 'gpt-5-nano');
  assert.strictEqual(r.reasoningEffort, 'minimal', 'GPT-5 -> reasoning minimal');
});

// LIVE-V2-BENCH — fragmentation comparison report.
test('--frag produces a legacy-vs-v2 fragmentation report', () => {
  const out = path.join(tmp, 'frag.json');
  execFileSync(process.execPath, [bench, '--frag', '--out', out],
    { env: { ...process.env, OPENAI_API_KEY: '' }, stdio: 'ignore' });
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(r.mode, 'fragmentation');
  assert.strictEqual(r.usingFixture, true, 'defaults to the segmenter fixtures with no transcript');
  for (const engine of ['legacy', 'v2']) {
    const s = r.engines[engine];
    assert.ok(s && typeof s.commits === 'number' && s.commits > 0, `${engine} has commits`);
    assert.ok(typeof s.avgWordsPerCommit === 'number', `${engine} avg words/commit`);
    assert.ok(typeof s.pctEndingMidClause === 'number', `${engine} mid-clause %`);
    assert.ok(s.clauseLatencyMs && 'median' in s.clauseLatencyMs && 'p95' in s.clauseLatencyMs, `${engine} clause latency`);
  }
  // v2 fragments less: fewer, longer commits that end at boundaries, no word loss.
  assert.ok(r.engines.v2.avgWordsPerCommit > r.engines.legacy.avgWordsPerCommit, 'v2 clauses are longer');
  assert.ok(r.engines.v2.pctEndingMidClause <= r.engines.legacy.pctEndingMidClause, 'v2 ends mid-clause no more than legacy');
  assert.strictEqual(r.engines.v2.lostWords, 0, 'v2 loses no words');
  assert.strictEqual(r.engines.v2.duplicatedWords, 0, 'v2 duplicates no words');
});

if (failures) { console.error(`\nbench tests: ${failures} failure(s)`); process.exit(1); }
console.log('\nbench tests passed');
