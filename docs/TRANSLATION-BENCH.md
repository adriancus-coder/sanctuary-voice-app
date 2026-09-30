# Translation bench (SV-BENCH)

`scripts/bench.js` replays an archived service — or a plain transcript — through the
recognition + translation path under a chosen configuration and writes a report:
per-stage latency (median / p90), tokens + a rough cost estimate, and the full
source/translation pairs for manual quality review. It is read-only: it never
touches the live server, `sessions.json`, or a running event.

```bash
npm run bench -- --transcript <file.txt> --config current          # mocked recogniser
npm run bench -- --audio <file from AUDIO_ARCHIVE_DIR> --config current
npm run bench -- --audio <file> --config gpt5-nano --judge
```

## Options

| flag | meaning |
|---|---|
| `--config <name>` | pipeline preset: `current`, `gpt5-nano`, `azure-onestep` (default `current`) |
| `--transcript <file>` | **mocked recogniser** — segments come from this text file (one per line; blank lines separate). Use this to compare translation configs without audio or Azure. |
| `--audio <file>` | an archived audio file (see `AUDIO_ARCHIVE_DIR`). Transcribed for real when `OPENAI_API_KEY` is set. |
| `--targets en,no` | target languages to translate to (default `en,no`) |
| `--speed balanced` | translation mode used for the prompt (`rapid`/`balanced`/`clear`/`interpret`) |
| `--judge` | also score adequacy 1–5 per segment with the quality-tier model (RO→EN, RO→NO). Needs `OPENAI_API_KEY`. |
| `--out <report.json>` | where to write the JSON report (default `./bench-report-<config>-<ts>.json`) |

Without `OPENAI_API_KEY` the translator is a deterministic offline stub, so the
report shape is still produced (handy for dry runs / CI); real numbers need the key.

## The three comparisons on one recording

Run the same input three ways and compare the reports side by side:

```bash
# 1) Today's pipeline (gpt-4.1-nano fast / gpt-4.1-mini quality)
npm run bench -- --audio service.webm --config current --judge --out reports/current.json

# 2) GPT-5 nano fast tier (reasoning effort "minimal")
npm run bench -- --audio service.webm --config gpt5-nano --judge --out reports/gpt5-nano.json

# 3) Azure one-step (speech -> translated text in one stream)
#    Azure translation is a live-stream feature: run it on STAGING with
#    SPEECH_PROVIDER=azure_sdk and SPEECH_TRANSLATION_PROVIDER=azure, driving a real
#    service, and read the same per-event latency summary from the transcript page
#    (SV-LATENCY-METRICS). For an offline translation-quality comparison, run the
#    bench with --transcript <same segments> --config current vs gpt5-nano.
```

`config: azure-onestep` on a `--transcript` run measures the LLM translate of those
segments (a baseline); the true one-step numbers come from a live staging run,
where recognition and translation happen together in Azure and the metrics panel
reports the combined latency.

## Reading the report

- `latencyMs.recognition` — median / p90 / max of recognition latency (only when
  `--audio` was transcribed for real; a transcript run has none).
- `latencyMs.translationByTarget.<lang>` — translate latency per target language.
- `tokens` — `total`, `cached` (prompt-cache hits) and `uncached`. A stable system
  prompt (instructions + church glossary + style, see `lib/prompt.js`) is what makes
  `cached` climb across segments.
- `costEstimateUsd` — rough, from a blended per-model price table; treat as an order
  of magnitude, not a bill.
- `adequacyByTarget` (with `--judge`) — mean 1–5 adequacy per target.
- `pairs` — every segment with its source and each target's translation, latency,
  tokens, and (with `--judge`) adequacy — for eyeballing quality.

## What the bench proves

Because the live translation prompt lives in `lib/prompt.js` (shared by `server.js`
and the bench) and the OpenAI call goes through the same `lib/translation.js`, the
`current` config reproduces the live translation behaviour. Comparing configs on one
recording shows the latency/quality/cost trade-off before any switch is flipped in
production — nothing in the live path changes until an operator opts in.
