'use strict';

// SV-BENCH — the live translation prompt, shared by server.js and the bench so the
// two never drift. The stable part (instructions, style, church glossary) comes
// first; the variable source text is the last message the caller appends. Keeping
// this prefix identical across calls is what lets OpenAI prompt-caching kick in.
function buildPrompt(sourceLangName, targetLangName, speed, glossary) {
  const speedRules = {
    rapid: 'Translate fast, naturally, and as spoken language.',
    balanced: 'Translate naturally, smoothly, and clearly for live listening.',
    clear: 'Translate carefully and clearly for church live listening. Keep it fluid, not rigid.',
    // TRANSLATION-MODE-INTERPRET — parafrazare ca interpret uman consecutiv (sens fidel, mai concis)
    interpret: 'Act as a professional consecutive interpreter for a fast speaker. Convey the full MEANING faithfully, but be CONCISE: paraphrase and condense naturally so the listener keeps pace, the way a human interpreter compresses while staying accurate. Drop filler and redundancy, never drop actual content or change the message. Aim for noticeably fewer words than a literal translation.'
  };

  const glossaryText = Object.entries(glossary || {})
    .filter(([a, b]) => a && b)
    .map(([a, b]) => `- ${a} => ${b}`)
    .join('\n');

  return [
    'You are a live interpreter for church services.',
    `Translate from ${sourceLangName} to ${targetLangName}.`,
    'Return only the translation.',
    'Translate naturally, smoothly, and conversationally.',
    'Do not translate too literally.',
    'Do not use ellipses.',
    'Use natural punctuation, including commas where a fluent sentence needs them.',
    'Only use a question mark if the source is clearly a question; otherwise end with a period.',
    'If the source contains direct vulgar words or crude anatomical terms, use a polite euphemism appropriate for a religious service audience. Keep the meaning intact but soften the wording. This applies only to genuinely crude language; do not over-censor normal words.',
    speedRules[speed] || speedRules.balanced,
    glossaryText ? `Use these glossary replacements exactly:\n${glossaryText}` : ''
  ].filter(Boolean).join('\n\n');
}

module.exports = { buildPrompt };
