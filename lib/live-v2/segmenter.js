'use strict';

// LIVE-V2-SEGMENTER — pure, per-event clause segmenter for the v2 live engine.
//
// No I/O, no timers, no sockets, no shared state: one instance per event. It
// consumes Azure recognition events — partials from `recognizing`, finals from
// `recognized` — and returns committed CLAUSES plus the current provisional
// tail. Two invariants it must never break:
//
//   1. Delta correctness: it never re-emits committed text (no duplicates) and
//      never drops words when Azure revises the end of a hypothesis.
//   2. Stability: mid-utterance it commits only text that is STABLE — unchanged
//      across at least two consecutive partials — and only at a natural clause
//      boundary once the clause has grown to at least MIN_CLAUSE_WORDS. A hard
//      cap of MAX_CLAUSE_WORDS forces a cut (nearest boundary, else a word) so
//      a long unsegmented sentence still flows.
//
// On a final the whole remaining uncommitted text is committed (split into
// bounded clauses); the last clause carries `endsSentence` when the final text
// ends with sentence punctuation.

// Per-mode Azure segmentation-silence (ms). v2 uses calmer values than the
// legacy engine so Azure cuts less aggressively and the segmenter does the
// fine-grained clause splitting itself. The pipeline reads this to configure
// Speech_SegmentationSilenceTimeoutMs for v2 events only.
const SEGMENTATION_SILENCE_MS = { rapid: 350, balanced: 500, clear: 800, interpret: 700 };
function segmentationSilenceMs(mode) {
  return SEGMENTATION_SILENCE_MS[mode] || SEGMENTATION_SILENCE_MS.balanced;
}

// Conjunctions that OPEN a new clause → the cut goes BEFORE the word. The
// Romanian set is the spec's (și / dar / iar / însă / pentru că / fiindcă /
// deci); the others are a modest equivalent set so non-RO sources still split.
const CONJ_BEFORE = {
  ro: new Set(['și', 'si', 'dar', 'iar', 'însă', 'insa', 'deci', 'fiindcă', 'fiindca', 'căci', 'caci']),
  en: new Set(['and', 'but', 'so', 'because', 'therefore', 'however']),
  no: new Set(['og', 'men', 'så', 'sa', 'fordi', 'derfor', 'altså', 'altsa']),
  es: new Set(['y', 'pero', 'porque', 'así', 'asi', 'entonces']),
  fr: new Set(['et', 'mais', 'parce', 'donc', 'car']),
  de: new Set(['und', 'aber', 'weil', 'denn', 'also', 'deshalb']),
  it: new Set(['e', 'ma', 'perché', 'perche', 'quindi', 'allora']),
  pt: new Set(['e', 'mas', 'porque', 'então', 'entao', 'portanto']),
  ru: new Set(['и', 'но', 'потому', 'поэтому', 'значит'])
};
// Two-token openers: the cut goes BEFORE the first token when the next token
// matches (e.g. Romanian "pentru că").
const CONJ_BEFORE_PAIR = {
  ro: [['pentru', 'că'], ['pentru', 'ca']]
};

const MIN_CLAUSE_WORDS = 12;
const MAX_CLAUSE_WORDS = 40;

function normalize(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}
function tokenize(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}
// Number of leading tokens two arrays share — the "seen in ≥2 partials" region.
function commonPrefixCount(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}
// Lowercased word with leading/trailing non-letters stripped, for conj. lookup.
function stripWord(w) {
  return String(w || '').toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
}
// A word that ends a comma/semicolon/colon boundary (closing quotes allowed).
function endsWithMidPunct(w) {
  return /[,;:][)"'»”’\]]*$/.test(String(w || ''));
}
// The final text closes a sentence (terminal . ! ? with optional closing quote).
function endsWithSentencePunct(text) {
  return /[.!?]["'»”’)\]]*\s*$/.test(String(text || ''));
}

// Scan `words` and return the clause cuts to commit, left to right. Each cut is
// { len, reason } where len is the clause length in words (relative to the end
// of the previous cut). `commitAll` (finals) commits every word, splitting only
// to keep clauses bounded; otherwise (partials) it commits only full natural
// clauses and forces a cut at the hard cap, leaving the rest as provisional.
function findCuts(words, sourceLang, commitAll) {
  const conj = CONJ_BEFORE[sourceLang] || CONJ_BEFORE.ro;
  const pairs = CONJ_BEFORE_PAIR[sourceLang] || [];
  const cuts = [];
  let start = 0;

  while (start < words.length) {
    let cut = -1;
    let reason = '';

    for (let i = start; i < words.length; i += 1) {
      const clauseLen = i - start + 1; // words up to and including i
      // Boundary AFTER word i (mid punctuation).
      if (clauseLen >= MIN_CLAUSE_WORDS && endsWithMidPunct(words[i])) {
        cut = i + 1;
        reason = 'punct';
        break;
      }
      // Boundary BEFORE word i (conjunction opens a new clause).
      const beforeLen = i - start; // words strictly before i
      if (beforeLen >= MIN_CLAUSE_WORDS) {
        const w = stripWord(words[i]);
        const isPair = pairs.some(([a, b]) => w === a && stripWord(words[i + 1]) === b);
        if (conj.has(w) || isPair) {
          cut = i;
          reason = 'conj';
          break;
        }
      }
    }

    if (cut === -1) {
      const remaining = words.length - start;
      if (remaining >= MAX_CLAUSE_WORDS) {
        // Hard cap: nearest boundary within the cap window, else a plain word cut.
        const forced = forceCut(words, start, sourceLang);
        cut = forced.cut;
        reason = forced.reason;
      } else if (commitAll && remaining > 0) {
        // Final: the remainder (even if short) is its own clause.
        cut = words.length;
        reason = 'final';
      } else {
        break; // partial: leave the remainder as the provisional tail
      }
    }

    cuts.push({ len: cut - start, reason });
    start = cut;
  }
  return cuts;
}

// Force a cut for a clause that reached the hard cap with no natural boundary
// at/after MIN_CLAUSE_WORDS: prefer the last boundary within [start, start+MAX],
// otherwise cut at exactly MAX words.
function forceCut(words, start, sourceLang) {
  const conj = CONJ_BEFORE[sourceLang] || CONJ_BEFORE.ro;
  const pairs = CONJ_BEFORE_PAIR[sourceLang] || [];
  const limit = Math.min(words.length, start + MAX_CLAUSE_WORDS);
  let best = -1;
  let bestReason = '';
  for (let i = start; i < limit; i += 1) {
    if (endsWithMidPunct(words[i])) {
      best = i + 1;
      bestReason = 'punct';
    }
    if (i > start) {
      const w = stripWord(words[i]);
      const isPair = pairs.some(([a, b]) => w === a && stripWord(words[i + 1]) === b);
      if ((conj.has(w) || isPair) && i > best) {
        best = i;
        bestReason = 'conj';
      }
    }
  }
  if (best > start) return { cut: best, reason: bestReason };
  return { cut: limit, reason: 'word' };
}

function createSegmenter(options = {}) {
  const sourceLang = String(options.sourceLang || 'ro').toLowerCase();

  // Per-utterance state. An utterance is the span between two `recognized`
  // finals; `committed` is the prefix of the current hypothesis we have already
  // emitted, `prevWords` the previous partial's tokens (for the stable region).
  let committed = '';
  let prevWords = [];

  function reset() {
    committed = '';
    prevWords = [];
  }

  // Emit clauses whose cut lengths are relative to `committedCount` (the start
  // of the uncommitted region). Updates `committed` to the full emitted prefix.
  // The last clause's endsSentence is set to `lastEndsSentence` (finals only);
  // all others are false.
  function emitRelative(words, committedCount, cuts, lastEndsSentence) {
    const commits = [];
    let idx = committedCount;
    for (let c = 0; c < cuts.length; c += 1) {
      const { len, reason } = cuts[c];
      const clauseWords = words.slice(idx, idx + len);
      idx += len;
      const text = clauseWords.join(' ');
      if (!text) continue;
      const isLast = c === cuts.length - 1;
      const endsSentence = !!(lastEndsSentence && isLast);
      commits.push({ text, endsSentence, words: clauseWords.length, reason: endsSentence ? 'sentence' : reason });
    }
    committed = words.slice(0, idx).join(' ');
    return commits;
  }

  // How many leading words of the current hypothesis are already committed.
  // Anchored on committed length (never on a fresh match) so a tail revision
  // can never make us re-emit committed text.
  function committedCountFor() {
    return tokenize(committed).length;
  }

  function provisionalFrom(words) {
    const tail = words.slice(committedCountFor());
    return tail.join(' ');
  }

  // A `recognizing` partial: commit any newly-stable full clauses, return the
  // provisional tail.
  function pushPartial(text) {
    const words = tokenize(text);
    if (!words.length) {
      // Azure can briefly emit an empty hypothesis; keep state, nothing to do.
      return { commits: [], provisional: provisionalFrom(prevWords.length ? prevWords : []) };
    }
    const committedCount = committedCountFor();
    const stableCount = commonPrefixCount(prevWords, words);
    prevWords = words;

    // Only words that are both uncommitted AND stable may be committed now.
    const stableEnd = Math.max(committedCount, Math.min(stableCount, words.length));
    if (stableEnd <= committedCount) {
      return { commits: [], provisional: provisionalFrom(words) };
    }
    const uncommittedStable = words.slice(committedCount, stableEnd);
    const cuts = findCuts(uncommittedStable, sourceLang, false);
    const commits = emitRelative(words, committedCount, cuts, false);
    return { commits, provisional: provisionalFrom(words) };
  }

  // A `recognized` final: commit all remaining uncommitted words (split into
  // bounded clauses), mark the last clause as sentence-ending when appropriate,
  // then reset for the next utterance.
  function pushFinal(text) {
    const words = tokenize(text);
    const committedCount = committedCountFor();
    if (!words.length || words.length <= committedCount) {
      reset();
      return { commits: [], provisional: '' };
    }
    const uncommitted = words.slice(committedCount);
    const cuts = findCuts(uncommitted, sourceLang, true);
    const lastEndsSentence = endsWithSentencePunct(text);
    const commits = emitRelative(words, committedCount, cuts, lastEndsSentence);
    reset();
    return { commits, provisional: '' };
  }

  return {
    pushPartial,
    pushFinal,
    reset,
    get provisional() { return provisionalFrom(prevWords); },
    // exposed for tests / debugging
    _state() { return { committed, prevWords: prevWords.slice() }; }
  };
}

module.exports = {
  createSegmenter,
  segmentationSilenceMs,
  SEGMENTATION_SILENCE_MS,
  MIN_CLAUSE_WORDS,
  MAX_CLAUSE_WORDS,
  // internals exported for unit tests
  _findCuts: findCuts,
  _tokenize: tokenize
};
