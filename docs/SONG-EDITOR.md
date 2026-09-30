# Song editor ↔ storage mapping (SV-SONG-EDITOR)

The "Cântare nouă" / edit-song experience is a shared component
(`public/song-editor.js`) used on the **admin Cântări card** and on **/worship**.
It is modelled on worship-app's editor but self-contained for Sanctuary Voice: it
inlines its own DOM helper, a per-device chord-notation switch (letters / solfège,
localStorage `sv_chord_notation`), and the section preview, and it works under
**both** i18n engines because the caller passes a `t(key)` function at `create()`
(admin → `adminI18n`; worship → `window.I18N`).

Supporting helpers ported (nearly verbatim) from worship-app:

- `public/chords.js` (`window.CHORDS`) — inline ChordPro helpers:
  `chordsOverLyricsToInline`, `stripChords`, `inlineToChordsOverLyrics`,
  `inlineLinePairs`, `toNotation` / `renderContent`, `keyAfter`, `transpose*`.
- `public/sections.js` (`window.SECTIONS`) — `SECTION_TYPES` (7:
  `verse, chorus, pre_chorus, bridge, intro, outro, other`; RO: strofă, refren,
  pre-refren, punte, intro, final, altceva), `normalizeType` (unknown/legacy →
  `other`), `leadingLabel` / `stripLeadingLabel`, `sectionLabels`, `SONG_KEYS`.

## The component's data shape

`editor.setSong(song)` / `editor.payload()` speak:

```
{ title, author, key, sourceLang, sections: [ { type, label, content, note } ] }
```

`content` is **inline ChordPro** (`[G]Ne ridici...`). Pasting a whole lyric with
blank lines splits it into sections (type inferred from a leading label such as
`Refren:`/`Strofa 2`, else `verse`), and "chord line above lyric line" pasted text
is converted to inline ChordPro on blur.

## Storage (sessions.json) — additive only

The library item keeps the **existing** shape exactly (old songs re-save
byte-identically), and only **adds** keys:

| library item field   | source                          | notes |
|----------------------|---------------------------------|-------|
| `text`               | `stripChords(content)` per section, joined by a blank line | **LYRICS ONLY** — no chords ever |
| `labels[]`           | each section's custom `label`    | unchanged behaviour |
| `sourceLang`         | song language (admin picker; worship preserves it) | unchanged |
| `key`                | letter key (e.g. `G`), additive | already existed on the item |
| `sectionTypes[]`     | the 7 editor types, additive    | parallel to the stored blocks |
| `sectionNotes[]`     | per-section `note`, additive     | reused existing field (sent as `notes`) |
| `sectionsChordPro[]` | inline ChordPro per section, additive | **where the chords live** |
| `author`             | additive                        | new |

Because the stored `text` is lyrics-only, the **projector (`translate.html`),
participant flow, and the STT/translation pipeline are completely unchanged and
never see chords**. Chords are restored into the editor from `sectionsChordPro[]`
on reopen; when that field is absent (old songs), the section `content` falls back
to the stored block (lyrics only) and the type is inferred from `sectionTypes[]`
→ the stored label → `verse`.

### Alignment & byte-identity

On save the client drops sections with no lyrics and normalises each block exactly
like the server's `splitSongBlocks` (chords stripped, lines trimmed, blanks
dropped), so `sectionTypes` / `sectionNotes` / `sectionsChordPro` stay aligned to
the stored blocks and an unedited legacy song re-saves with `text` + `labels`
**byte-identical**.

## Server

`upsertLibraryItem` (server.js) and the two song-library POSTs
(`/api/global-song-library`, `/api/events/:id/song-library`) accept + persist the
additive keys (via `readSongEditorFields` in `routes/events.js`) and return
`existingId` on a duplicate title so the editor can show an inline "open existing"
link. The live **song/load** path is left untouched — it receives the lyrics-only
`text`, so nothing about the display / translation pipeline changes.
