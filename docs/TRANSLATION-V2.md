# Live translation engine v2

The v2 engine replaces the legacy "buffer / flush / split" live pipeline with a
**clause-at-a-time** flow built from scratch in new files. The legacy engine is
untouched and stays available as a per-event fallback.

v2 exists because the legacy path broke text too often and in the wrong places:
five overlapping cutting layers (Azure 300 ms segmentation, word-count flush,
SMART FLUSH V1/V2, the 3/6/12-word buffer, `splitLongPiece`) chopped speech into
6–12-word fragments mid-idea, each fragment was translated alone without context,
`lib/prompt.js` forced a period on every fragment, and `participant.js` replaced
the whole live line on each entry so the text jumped.

## What changed

- **One cutting layer.** Azure runs with a calmer per-mode segmentation silence
  and the new segmenter does the clause splitting — no competing flush layers.
- **Clauses, not fragments.** Commits are whole clauses (≥ 12 words, cut at a
  natural boundary; 40-word hard cap), never re-sent and never dropped.
- **Context + no forced period.** Each clause is translated with the last two
  committed clauses as context, and only gets terminal punctuation when it
  actually ends a sentence.
- **Continuous subtitles.** Participants see committed text appended to a
  flowing paragraph with a dimmer provisional tail — the text never jumps.

## Files

| File | Role |
|---|---|
| `lib/live-v2/segmenter.js` | Pure, per-event clause segmenter (no I/O). Azure partials/finals → committed clauses + provisional tail + `endsSentence`. |
| `lib/live-v2/prompt.js` | Clause-at-a-time prompt: stable cacheable prefix + last-2-clause context + per-call directive. |
| `lib/live-v2/pipeline.js` | Per-process orchestration: ordered commit queue, throttled/abortable provisional, socket + bridge emits, transcript save, metrics. |
| `server.js` | Wires the Azure recognizer handlers to the pipeline for v2 events; `translateClauseV2`, `getEventTranslationEngine`, the `liveV2` instance. |
| `public/participant.js` / `.html` / `styles.css` | The flowing-subtitle participant view. |
| `scripts/test-live-v2-segmenter.js` | Segmenter unit tests (in `npm run check`). |
| `scripts/bench.js --frag` | Legacy-vs-v2 fragmentation bench. |

## Flow

```
Azure SpeechRecognizer (provider azure_sdk, one-step OFF)
   recognizing (partials) ─┐
   recognized  (finals)  ──┤
                           ▼
            lib/live-v2/segmenter.js  (per event)
               • commit STABLE clauses at a boundary (≥12 words, ≤40)
               • emit the provisional (uncommitted) tail + endsSentence
                           │
                           ▼
            lib/live-v2/pipeline.js  (per event)
   committed clause ──► ordered per-event queue ──► translateClauseV2 (per lang)
                           │                               │
                           │                               ├─ transcript_entry      (admin, history, export)
                           │                               ├─ live_v2_commit         (participants)
                           │                               └─ bridge translation.final
                           │
   provisional tail ──► throttled streaming translate (abort on commit)
                                                           ├─ live_v2_provisional    (participants)
                                                           └─ bridge translation.partial
```

The projector (`translate.html`) is never sent live text by v2 — it only renders
`display_live_entry`, which v2 does not emit.

## Segmenter

`createSegmenter({ sourceLang })` → `{ pushPartial(text), pushFinal(text), reset(), provisional }`.
Each call returns `{ commits: [{ text, endsSentence, words, reason }], provisional }`.

- **Commit on final.** `recognized` commits the whole remaining uncommitted text,
  split into bounded clauses; the last clause's `endsSentence` is true when the
  final text ends with `.`, `!` or `?`.
- **Stable mid-utterance commit.** While an utterance grows without a final, only
  text unchanged across ≥ 2 consecutive partials (the common word-prefix) may be
  committed, and only at a natural boundary — `,` `;` `:` or before a conjunction
  (`și`, `dar`, `iar`, `însă`, `pentru că`, `fiindcă`, `deci`, plus per-source
  equivalents for en/no/es/fr/de/it/pt/ru) — once the clause reaches **12 words**.
- **Hard cap 40 words.** A long run with no boundary is cut at the nearest
  boundary within the cap, otherwise at a word.
- **No duplication / loss.** Committed text is anchored by length, so Azure
  revising the tail of a partial never re-sends or drops words.

### Per-mode Azure segmentation silence (v2 only)

| Mode | ms |
|---|---|
| rapid | 350 |
| balanced | 500 |
| clear | 800 |
| interpret | 700 |

Applied via `Speech_SegmentationSilenceTimeoutMs` only for v2 events; legacy keeps
its own table.

## Prompt

`buildLiveV2Messages({ sourceLangName, targetLangName, speed, glossary, contextClauses, clause, endsSentence })`:

1. a **stable** system prefix (role, flowing-subtitle style, euphemism rule, the
   per-mode rule incl. `interpret` condensation, and the event glossary) — kept
   byte-identical per event+language+mode so OpenAI prompt-caching keys on it;
2. the last two committed clauses as `user`/`assistant` turns;
3. a per-call directive: translate only the new clause, do not repeat context, no
   leading capital, and terminal punctuation **only** when `endsSentence`;
4. the new clause as the final `user` message.

`translateClauseV2` strips a trailing period from a non-sentence-ending clause,
reuses the fast/quality model tiers (clear/interpret → quality), the translate
concurrency slot, the translation cache (committed only) and abort/timeout.

## Socket events (participants)

Additive; legacy events never receive these.

- `live_v2_commit` — a committed clause:
  `{ eventId, seq, paragraphId, source, translations: { <lang>: text }, endsSentence, createdAt }`
- `live_v2_provisional` — the current uncommitted tail (replaced in place):
  `{ eventId, seq, paragraphId, source, translations: { <lang>: text } }`

`seq` is strictly increasing per event (dedupe / ordering). `source` is the source
text (shown when the viewer's language is the source language). A **new paragraph**
(`paragraphId`) starts after a sentence-ending clause once the paragraph passes
40 words, or after a pause > 3 s.

`transcript_entry` (per committed clause) and the admin `partial_transcript`
preview are still emitted, so admin, history and export are unchanged.

## Participant view

Committed clauses are **appended** to their paragraph (never replaced); the
provisional tail trails after, dimmer, replaced in place; earlier paragraphs stay
above (last 30 kept). Auto-scroll only while pinned to the bottom; scrolling up
reveals a localized **Back to live** button. Bible-reference highlighting and the
wake lock are preserved; the auto-expire blanking is disabled for v2 (the flowing
view persists). Switching language reflows from the per-clause translations
already held.

## Bridge

The `docs/BRIDGE.md` contract is unchanged: each committed clause is a
`translation.final`, the provisional tail is a `translation.partial`. No new
required fields. (The participant-only `seq` / `paragraphId` are not sent to the
bridge.)

## Fallback

A v2 event automatically uses the **legacy** engine when:

- the speech provider is not `azure_sdk` (e.g. the OpenAI upload path), or
- Azure one-step translation is active for the event
  (`SPEECH_TRANSLATION_PROVIDER=azure` on a fast-tier mode).

When this happens a clear line is logged:
`[live-v2] event=<id> requested v2 but using LEGACY (onestep=…, provider=…)`.
When v2 is active you instead see
`[live-v2] engine=v2 ACTIVE event=<id> src=… speed=…`.

## Switching engine

- **Per event (admin):** Recepție tab → **Motor de traducere / Translation engine**
  → *Nou/New* (v2) or *Vechi/Legacy* (v1). It takes effect at the **next Start**
  (like the translation mode), not mid-session.
- **Storage:** the additive event key `translationEngine` (`'v2'` | `'v1'`). New
  events are `'v2'`; existing events with no key read as `'v2'`. Set `'v1'` to pin
  an event to the legacy engine.
- **API:** `POST /api/events/:id/settings` with `{ "translationEngine": "v1" }`
  (or `"v2"`).

The engine is read at Azure session start, so after changing it the operator stops
and starts live recognition to apply it.

## Benchmark

```
npm run bench:frag                      # RO fixtures, legacy vs v2
node scripts/bench.js --frag --transcript <file.txt>
node scripts/bench.js --frag --audio <file> --config current   # needs OPENAI_API_KEY
```

Reports avg words/commit, % of commits ending mid-clause, duplicated/lost words,
and per-clause translate latency (median, p95). With no archived audio it runs on
`scripts/fixtures/bench-fragmentation-ro.txt` and says so; the legacy column is an
approximation of the 6–12-word display chunker (the real splitter lives in
`server.js`). Example on the RO fixtures (mock translator, latency not meaningful):

| metric | legacy | v2 |
|---|---|---|
| commits | 12 | 8 |
| avg words / commit | 8.08 | 12.13 |
| % ending mid-clause | 16.7 | 0 |
| duplicated words | 0 | 0 |
| lost words | 0 | 0 |

## Tests

`npm run check` runs `scripts/test-live-v2-segmenter.js` (segmenter), the v2 prompt
cases in `scripts/test-translation.js`, and the `--frag` report case in
`scripts/test-bench.js`.
