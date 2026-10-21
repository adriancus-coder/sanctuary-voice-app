'use strict';

// LIVE-V2-PROMPT — the prompt for the v2 live engine. Unlike the legacy
// single-shot prompt (lib/prompt.js), v2 translates ONE clause at a time as a
// continuous, flowing subtitle, so the prompt is split into:
//
//   1. a STABLE system prefix (role, style, euphemism rule, per-mode rule,
//      glossary) that is byte-identical across every call for a given
//      event+language+mode — this is what OpenAI prompt-caching keys on;
//   2. the last two committed clauses (source + the translation already shown)
//      as prior turns, explicitly marked "already displayed, context only";
//   3. a per-call directive carrying the variable rules (no-repeat, no leading
//      capital, and whether this clause ends a sentence);
//   4. the new clause alone as the final user message.
//
// The model returns only the translation of the new clause.

// Per-mode style, mirroring lib/prompt.js but phrased for fragment-by-fragment
// subtitles. "interpret" keeps the human-interpreter condensation.
const MODE_RULES = {
  rapid: 'Translate fast, naturally, and as spoken language.',
  balanced: 'Translate naturally, smoothly, and clearly for live listening.',
  clear: 'Translate carefully and clearly for church live listening. Keep it fluid, not rigid.',
  interpret: 'Act as a professional consecutive interpreter for a fast speaker. Convey the full MEANING faithfully, but be CONCISE: paraphrase and condense naturally so the listener keeps pace, the way a human interpreter compresses while staying accurate. Drop filler and redundancy, never drop actual content or change the message. Aim for noticeably fewer words than a literal translation.'
};

const EUPHEMISM_RULE =
  'If the source contains direct vulgar words or crude anatomical terms, use a polite euphemism appropriate for a religious service audience. Keep the meaning intact but soften the wording. This applies only to genuinely crude language; do not over-censor normal words.';

function glossaryBlock(glossary) {
  const text = Object.entries(glossary || {})
    .filter(([a, b]) => a && b)
    .map(([a, b]) => `- ${a} => ${b}`)
    .join('\n');
  return text ? `Use these glossary replacements exactly:\n${text}` : '';
}

// The cacheable system prefix. Keep it free of per-clause data so it stays
// byte-identical across calls (prompt caching).
function buildStableSystemPrompt(sourceLangName, targetLangName, speed, glossary) {
  return [
    'You are a live interpreter for church services.',
    `Translate from ${sourceLangName} to ${targetLangName}.`,
    'The source is transcribed live and shown to the audience as a continuous, flowing subtitle — one short fragment (a clause) at a time, appended after the previous fragments.',
    'Translate each fragment so it reads naturally as the continuation of the ones before it.',
    'Return only the translation of the current fragment — no quotes, no labels, no commentary.',
    'Do not use ellipses.',
    'Translate naturally and conversationally; do not translate too literally.',
    EUPHEMISM_RULE,
    MODE_RULES[speed] || MODE_RULES.balanced,
    glossaryBlock(glossary)
  ].filter(Boolean).join('\n\n');
}

// The per-call directive (variable): no-repeat of context, no leading capital,
// and the sentence-ending rule driven by the segmenter's endsSentence flag.
function buildClauseDirective(endsSentence) {
  const lines = [
    'Everything above was already shown to the audience; use it only for context and do not repeat any of it.',
    'Translate ONLY the new fragment below.',
    'Do not capitalize the first word unless it is a proper noun or the name of God — the fragment continues the previous text.'
  ];
  if (endsSentence) {
    lines.push('This fragment ends a sentence: close it with the appropriate terminal punctuation (. ! or ?).');
  } else {
    lines.push('This fragment does NOT end a sentence: do not add a final period or any terminal punctuation — it continues in the next fragment.');
  }
  return lines.join('\n');
}

// Build the full input message array for translationService.translate*.
// contextClauses: up to the last 2 committed clauses as
// { source, translation } — the source text and the translation already shown
// in THIS target language.
function buildLiveV2Messages({ sourceLangName, targetLangName, speed, glossary, contextClauses, clause, endsSentence }) {
  const messages = [
    { role: 'system', content: buildStableSystemPrompt(sourceLangName, targetLangName, speed, glossary) }
  ];
  const ctx = Array.isArray(contextClauses) ? contextClauses.slice(-2) : [];
  for (const c of ctx) {
    if (!c) continue;
    if (c.source) messages.push({ role: 'user', content: String(c.source) });
    if (c.translation) messages.push({ role: 'assistant', content: String(c.translation) });
  }
  messages.push({ role: 'system', content: buildClauseDirective(!!endsSentence) });
  messages.push({ role: 'user', content: String(clause || '') });
  return messages;
}

module.exports = {
  buildLiveV2Messages,
  buildStableSystemPrompt,
  buildClauseDirective,
  MODE_RULES
};
