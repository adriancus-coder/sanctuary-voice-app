'use strict';

// SV-BENCH — replay an archived service (or a transcript) through the recognition
// + translation path under any configuration, and write a report: per-stage
// latency (median / p90), tokens + a rough cost estimate, and the full source/
// translation pairs for manual review. Optional --judge scores adequacy 1–5 with
// the quality-tier model. See docs/TRANSLATION-BENCH.md.
//
//   npm run bench -- --audio <file> --config current [--judge]
//   npm run bench -- --transcript <file.txt> --config gpt5-nano   (mocked recogniser)
//
// The recogniser is "mocked" by passing --transcript (one segment per line, blank
// lines separate). With --audio and an OPENAI_API_KEY the audio is transcribed for
// real. With no OPENAI_API_KEY the translator is a deterministic offline stub so a
// report is still produced (useful for smoke tests / dry runs).

const fs = require('fs');
const path = require('path');
const { createTranslationService } = require('../lib/translation');
const { buildPrompt } = require('../lib/prompt');

const LANG_NAMES = {
  ro: 'Romanian', en: 'English', no: 'Norwegian', ru: 'Russian', uk: 'Ukrainian',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  pl: 'Polish', tr: 'Turkish', ar: 'Arabic', fa: 'Persian', hu: 'Hungarian', el: 'Greek'
};

// Rough blended $/1M tokens (input+output) for a cost estimate only.
const COST_PER_MTOK = {
  'gpt-4.1-nano': 0.3, 'gpt-4.1-mini': 1.2, 'gpt-4.1': 5,
  'gpt-5-nano': 0.3, 'gpt-5-mini': 1.5, 'gpt-5': 6,
  'gpt-4o-mini': 0.7
};

const CONFIGS = {
  current: { fast: 'gpt-4.1-nano', quality: 'gpt-4.1-mini', provider: 'openai' },
  'gpt5-nano': { fast: 'gpt-5-nano', quality: 'gpt-5-mini', provider: 'openai' },
  'azure-onestep': { fast: 'azure-translation', quality: 'gpt-4.1-mini', provider: 'azure' }
};

function parseArgs(argv) {
  const args = { config: 'current', targets: ['en', 'no'], speed: 'balanced', source: 'ro' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--audio') args.audio = argv[++i];
    else if (a === '--transcript') args.transcript = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--judge') args.judge = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--targets') args.targets = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--speed') args.speed = argv[++i];
    else if (a === '--source') args.source = argv[++i];
  }
  return args;
}

function percentile(arr, p) {
  const xs = arr.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}
const stat = (a) => ({ median: percentile(a, 50), p90: percentile(a, 90), max: a.length ? Math.max(...a) : null });

function isReasoning(model) { return /gpt-5/i.test(String(model || '')); }

// Split a transcript file into segments: blank line separates, else one per line.
function segmentsFromText(text) {
  const t = String(text || '').replace(/\r/g, '');
  const byBlank = t.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return t.split(/\n/).map((s) => s.trim()).filter(Boolean);
}

// Deterministic offline translator (no API key) so the report still builds.
function mockService() {
  return {
    async translateWithResponsesDetailed({ input }) {
      const src = String((input[input.length - 1] || {}).content || '');
      const tag = /to ([A-Za-z]+)\./.exec((input[0] || {}).content || '');
      const lang = tag ? tag[1].slice(0, 2).toLowerCase() : 'xx';
      const words = src.split(/\s+/).filter(Boolean).length;
      return { text: `⟦${lang}⟧ ${src}`, tokens: words * 3, cachedTokens: Math.floor(words * 1.2) };
    }
  };
}

async function transcribeSegments(svc, audioFile, sourceLang) {
  // Whole-file transcription, then split into sentence-ish segments.
  const t0 = Date.now();
  const text = await svc.transcribeAudioFile({ filePath: audioFile, model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe', language: sourceLang });
  const recognitionMs = Date.now() - t0;
  const segs = String(text || '').split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  // One recognition call covered all segments; attribute its latency to the first.
  return segs.map((s, i) => ({ source: s, recognitionMs: i === 0 ? recognitionMs : null }));
}

async function judgeAdequacy(svc, model, source, translation, targetName) {
  const input = [
    { role: 'system', content: `You are grading a live church-service interpretation into ${targetName}. Rate ADEQUACY (meaning preserved) from 1 (wrong/missing) to 5 (fully faithful). Reply with ONLY the digit.` },
    { role: 'user', content: `Source (Romanian): ${source}\nTranslation (${targetName}): ${translation}` }
  ];
  try {
    const out = await svc.translateWithResponsesDetailed({ model, input });
    const m = /[1-5]/.exec(out.text || '');
    return m ? Number(m[0]) : null;
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = CONFIGS[args.config];
  if (!cfg) {
    console.error(`Unknown --config "${args.config}". Options: ${Object.keys(CONFIGS).join(', ')}`);
    process.exit(2);
  }
  const hasKey = !!process.env.OPENAI_API_KEY;
  let client = null;
  if (hasKey) { try { const OpenAI = require('openai'); client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); } catch { client = null; } }
  const svc = client ? createTranslationService({ client }) : mockService();
  const mocked = !client;

  if (cfg.provider === 'azure') {
    console.error('[bench] The azure-onestep config measures Azure speech-translation, which needs a live Azure stream + keys.');
    console.error('[bench] Run it against staging with SPEECH_PROVIDER=azure_sdk and SPEECH_TRANSLATION_PROVIDER=azure; the same report shape applies.');
    if (!args.transcript) process.exit(2);
  }

  // 1) Recognition -> segments.
  let segments;
  if (args.transcript) {
    segments = segmentsFromText(fs.readFileSync(args.transcript, 'utf8')).map((s) => ({ source: s, recognitionMs: null }));
    console.log(`[bench] mocked recogniser: ${segments.length} segment(s) from ${args.transcript}`);
  } else if (args.audio && client) {
    segments = await transcribeSegments(svc, args.audio, args.source);
    console.log(`[bench] transcribed ${segments.length} segment(s) from ${args.audio}`);
  } else {
    console.error('[bench] Provide --transcript <file> (mocked recogniser) or --audio <file> with OPENAI_API_KEY set.');
    process.exit(2);
  }

  // 2) Translate each segment for each target, timing every stage.
  const model = cfg.fast === 'azure-translation' ? 'gpt-4.1-nano' : cfg.fast; // bench measures the LLM translate for azure-onestep transcript runs
  const reasoningEffort = isReasoning(model) ? 'minimal' : undefined;
  const rows = [];
  const perTargetMs = {}; args.targets.forEach((l) => { perTargetMs[l] = []; });
  const recognitionMsAll = [];
  let totalTokens = 0; let cachedTokens = 0;

  for (const seg of segments) {
    if (typeof seg.recognitionMs === 'number') recognitionMsAll.push(seg.recognitionMs);
    const row = { source: seg.source, recognitionMs: seg.recognitionMs, targets: {} };
    for (const lang of args.targets) {
      const input = [
        { role: 'system', content: buildPrompt(LANG_NAMES[args.source] || args.source, LANG_NAMES[lang] || lang, args.speed, {}) },
        { role: 'user', content: seg.source }
      ];
      const t0 = Date.now();
      let out;
      try { out = await svc.translateWithResponsesDetailed({ model, input, reasoningEffort }); }
      catch (e) { out = { text: `[error: ${e.message}]`, tokens: 0, cachedTokens: 0 }; }
      const ms = Date.now() - t0;
      perTargetMs[lang].push(ms);
      totalTokens += Number(out.tokens || 0);
      cachedTokens += Number(out.cachedTokens || 0);
      row.targets[lang] = { text: out.text, ms, tokens: out.tokens || 0, cached: out.cachedTokens || 0 };
      if (args.judge && client) {
        row.targets[lang].adequacy = await judgeAdequacy(svc, cfg.quality, seg.source, out.text, LANG_NAMES[lang] || lang);
      }
    }
    rows.push(row);
  }

  // 3) Report.
  const priceKey = Object.keys(COST_PER_MTOK).find((k) => model.startsWith(k)) || model;
  const cost = (totalTokens / 1e6) * (COST_PER_MTOK[priceKey] || 0);
  const adequacyByTarget = {};
  if (args.judge && client) {
    for (const lang of args.targets) {
      const scores = rows.map((r) => r.targets[lang] && r.targets[lang].adequacy).filter((x) => typeof x === 'number');
      adequacyByTarget[lang] = scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : null;
    }
  }
  const report = {
    ranAt: new Date().toISOString(),
    config: args.config,
    model,
    reasoningEffort: reasoningEffort || null,
    mocked,
    source: args.source,
    targets: args.targets,
    segments: rows.length,
    latencyMs: {
      recognition: stat(recognitionMsAll),
      translationByTarget: Object.fromEntries(args.targets.map((l) => [l, stat(perTargetMs[l])]))
    },
    tokens: { total: totalTokens, cached: cachedTokens, uncached: Math.max(0, totalTokens - cachedTokens) },
    costEstimateUsd: Number(cost.toFixed(4)),
    adequacyByTarget: args.judge ? adequacyByTarget : undefined,
    pairs: rows
  };

  const outPath = args.out || path.join(process.cwd(), `bench-report-${args.config}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Human summary.
  console.log('');
  console.log(`Config: ${args.config}   model: ${model}${reasoningEffort ? ' (reasoning ' + reasoningEffort + ')' : ''}${mocked ? '   [MOCK translator — no OPENAI_API_KEY]' : ''}`);
  console.log(`Segments: ${rows.length}   tokens: ${totalTokens} (cached ${cachedTokens})   cost≈ $${cost.toFixed(4)}`);
  if (recognitionMsAll.length) console.log(`Recognition ms  median ${report.latencyMs.recognition.median} · p90 ${report.latencyMs.recognition.p90}`);
  for (const lang of args.targets) {
    const s = report.latencyMs.translationByTarget[lang];
    const adq = adequacyByTarget[lang] != null ? `   adequacy ${adequacyByTarget[lang]}/5` : '';
    console.log(`Translate RO→${lang.toUpperCase()} ms  median ${s.median} · p90 ${s.p90} · max ${s.max}${adq}`);
  }
  console.log(`\nReport written: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
