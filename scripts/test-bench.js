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

if (failures) { console.error(`\nbench tests: ${failures} failure(s)`); process.exit(1); }
console.log('\nbench tests passed');
