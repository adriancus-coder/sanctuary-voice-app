'use strict';

// LIVE-V2-SEGMENTER tests — exercise the pure clause segmenter against realistic
// Romanian Azure partial sequences: tail revisions, long unsegmented sentences,
// and short "Amin." / "Aleluia!" utterances. No network, no I/O. Exit 0/1.

const assert = require('assert');
const {
  createSegmenter,
  segmentationSilenceMs,
  _findCuts,
  _tokenize,
  MIN_CLAUSE_WORDS,
  MAX_CLAUSE_WORDS
} = require('../lib/live-v2/segmenter');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
// Drive a whole sequence of partials then one final; collect every commit.
function run(partials, finalText, opts) {
  const seg = createSegmenter(opts || {});
  const commits = [];
  let lastProvisional = '';
  for (const p of partials) {
    const r = seg.pushPartial(p);
    r.commits.forEach((c) => commits.push(c));
    lastProvisional = r.provisional;
  }
  if (finalText !== undefined) {
    const r = seg.pushFinal(finalText);
    r.commits.forEach((c) => commits.push(c));
    lastProvisional = r.provisional;
  }
  return { commits, provisional: lastProvisional };
}

// ----- per-mode segmentation silence table ------------------------------------
test('segmentation silence table (v2 values)', () => {
  assert.strictEqual(segmentationSilenceMs('rapid'), 350);
  assert.strictEqual(segmentationSilenceMs('balanced'), 500);
  assert.strictEqual(segmentationSilenceMs('clear'), 800);
  assert.strictEqual(segmentationSilenceMs('interpret'), 700);
  assert.strictEqual(segmentationSilenceMs('nonsense'), 500, 'unknown mode → balanced');
});

// ----- short utterances --------------------------------------------------------
test('short final "Amin." → one sentence-ending clause', () => {
  const { commits, provisional } = run([], 'Amin.');
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].text, 'Amin.');
  assert.strictEqual(commits[0].endsSentence, true);
  assert.strictEqual(provisional, '');
});

test('short final "Aleluia!" → sentence-ending clause', () => {
  const { commits } = run([], 'Aleluia!');
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].text, 'Aleluia!');
  assert.strictEqual(commits[0].endsSentence, true);
});

test('final without terminal punctuation → endsSentence false', () => {
  const { commits } = run([], 'Har și pace vouă');
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].endsSentence, false, 'no . ! ? → not a sentence end');
});

// ----- basic final under 12 words ---------------------------------------------
test('short sermon sentence final commits as one clause', () => {
  const src = 'Har și pace vouă de la Dumnezeu, Tatăl nostru.';
  const { commits } = run([], src);
  // 8 words, has an internal comma but < 12 words so no mid-cut: one clause.
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].text, src);
  assert.strictEqual(commits[0].endsSentence, true);
});

// ----- mid-utterance stable commit at a comma boundary ------------------------
test('mid-utterance: commits stable clause at a comma once ≥12 words', () => {
  // "...foarte bun," is 13 words and ends a comma boundary; it becomes stable
  // across two partials, so it commits mid-utterance (before the final arrives).
  const head = 'Vă spun astăzi dragii mei că Domnul nostru este cu adevărat foarte bun,';
  assert.strictEqual(_tokenize(head).length, 13, 'fixture is 13 words incl. the comma word');
  const partials = [
    'Vă spun astăzi',
    'Vă spun astăzi dragii mei că',
    head + ' și ne',          // makes the comma region appear...
    head + ' și ne iubește mult' // ...stable across two consecutive partials
  ];
  const { commits, provisional } = run(partials, undefined);
  assert.strictEqual(commits.length, 1, 'exactly one mid-utterance commit');
  assert.strictEqual(commits[0].text, head);
  assert.strictEqual(commits[0].endsSentence, false, 'mid-utterance is never a sentence end');
  assert.strictEqual(commits[0].reason, 'punct');
  assert.strictEqual(provisional, 'și ne iubește mult', 'uncommitted tail is the provisional');
});

test('mid-utterance commit then final: no duplicate, no lost words', () => {
  const head = 'Vă spun astăzi dragii mei că Domnul nostru este cu adevărat foarte bun,';
  const partials = [
    'Vă spun astăzi',
    'Vă spun astăzi dragii mei că',
    head + ' și ne',
    head + ' și ne iubește mult'
  ];
  const finalText = head + ' și ne iubește mult pe fiecare dintre noi.';
  const { commits, provisional } = run(partials, finalText);
  assert.strictEqual(provisional, '', 'final clears the provisional');
  // Reconstruct: every committed clause joined == the full sanitized sentence.
  const reconstructed = norm(commits.map((c) => c.text).join(' '));
  assert.strictEqual(reconstructed, norm(finalText), 'no words duplicated or lost');
  const last = commits[commits.length - 1];
  assert.strictEqual(last.endsSentence, true, 'last clause ends the sentence');
});

// ----- Azure revising the last words of a partial -----------------------------
test('tail revisions never commit unstable words; final commits once', () => {
  // The last word flips each partial ("el" → "în" → "întru ..."). The common
  // prefix stays at 11 words (< 12, no boundary), so nothing commits early.
  const stablePrefix = 'Domnul este păstorul meu și nu voi duce lipsă de nimic';
  assert.strictEqual(_tokenize(stablePrefix).length, 11);
  const partials = [
    stablePrefix + ' el',
    stablePrefix + ' în',
    stablePrefix + ' întru veci'
  ];
  const finalText = stablePrefix + ' întru vecii vecilor.';
  const { commits } = run(partials, finalText);
  assert.strictEqual(commits.length, 1, 'only the final commits — no unstable tail commit');
  assert.strictEqual(norm(commits[0].text), norm(finalText));
  assert.strictEqual(commits[0].endsSentence, true);
});

// ----- long unsegmented sentence hits the hard cap ----------------------------
test('final with no boundaries splits at the 40-word hard cap', () => {
  const words = Array.from({ length: 45 }, (_, i) => `cuvant${i}`);
  const finalText = words.join(' '); // no punctuation, no conjunctions
  const { commits } = run([], finalText);
  assert.strictEqual(commits.length, 2, '45 words → 40 + 5');
  assert.strictEqual(commits[0].words, MAX_CLAUSE_WORDS, 'first clause capped at 40');
  assert.strictEqual(commits[0].reason, 'word', 'forced word cut (no boundary)');
  assert.strictEqual(commits[1].words, 5);
  assert.strictEqual(commits[0].endsSentence, false);
  assert.strictEqual(commits[1].endsSentence, false, 'no terminal punctuation');
  // No words lost across the cap split.
  assert.strictEqual(norm(commits.map((c) => c.text).join(' ')), norm(finalText));
});

// ----- findCuts internals ------------------------------------------------------
test('_findCuts: cut BEFORE a conjunction once ≥12 words', () => {
  const words = _tokenize('unu doi trei patru cinci sase sapte opt noua zece unsprezece doisprezece și treisprezece');
  const cuts = _findCuts(words, 'ro', false);
  assert.strictEqual(cuts.length, 1);
  assert.strictEqual(cuts[0].len, 12, 'twelve words before "și"');
  assert.strictEqual(cuts[0].reason, 'conj');
});

test('_findCuts: cut AFTER a comma once ≥12 words', () => {
  const words = _tokenize('unu doi trei patru cinci sase sapte opt noua zece unsprezece doisprezece, treisprezece');
  const cuts = _findCuts(words, 'ro', false);
  assert.strictEqual(cuts.length, 1);
  assert.strictEqual(cuts[0].len, 12, 'twelve words incl. the comma word');
  assert.strictEqual(cuts[0].reason, 'punct');
});

test('_findCuts: "pentru că" is a two-token boundary', () => {
  const words = _tokenize('unu doi trei patru cinci sase sapte opt noua zece unsprezece doisprezece pentru că treisprezece');
  const cuts = _findCuts(words, 'ro', false);
  assert.strictEqual(cuts[0].len, 12, 'cut before "pentru"');
  assert.strictEqual(cuts[0].reason, 'conj');
});

test('_findCuts: no boundary and under cap on a partial → no cut', () => {
  const words = _tokenize('unu doi trei patru cinci sase sapte opt noua zece');
  assert.strictEqual(_findCuts(words, 'ro', false).length, 0, '10 words, no boundary → wait');
});

// ----- source-language conjunction sets ---------------------------------------
test('english source splits before "because"', () => {
  const words = _tokenize('one two three four five six seven eight nine ten eleven twelve because thirteen');
  const cuts = _findCuts(words, 'en', false);
  assert.strictEqual(cuts[0].len, 12);
  assert.strictEqual(cuts[0].reason, 'conj');
});

// ----- minimum clause guard ----------------------------------------------------
test('MIN/MAX constants are the spec values', () => {
  assert.strictEqual(MIN_CLAUSE_WORDS, 12);
  assert.strictEqual(MAX_CLAUSE_WORDS, 40);
});

if (failures) { console.error(`\nlive-v2 segmenter tests: ${failures} failure(s)`); process.exit(1); }
console.log('\nlive-v2 segmenter tests passed');
