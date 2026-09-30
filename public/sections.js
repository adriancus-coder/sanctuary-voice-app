'use strict';

// Song section types and their display labels. Ported (nearly verbatim) from
// worship-app public/sections.js for the shared song editor, with SV's 7 section
// types (no "tag"). Browser-only IIFE exposing window.SECTIONS. Labels come from
// the caller's i18n via a t(key) function (songs.sectionTypes.*, songs.sectionNumbered).

(function (root) {
  // SV uses 7 types: verse, chorus, pre_chorus, bridge, intro, outro, other.
  // RO labels: strofă, refren, pre-refren, punte, intro, final, altceva.
  const SECTION_TYPES = ['verse', 'chorus', 'pre_chorus', 'bridge', 'intro', 'outro', 'other'];

  // An unknown / legacy section type (e.g. worship-app's "tag") loads as "other".
  function normalizeType(type) {
    return SECTION_TYPES.includes(type) ? type : 'other';
  }

  // Allowed song keys: each root, major and minor ("G", "Gm").
  const SONG_KEYS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']
    .flatMap((r) => [r, `${r}m`]);

  // Display labels for an ordered list of sections ({ type, label }).
  // A custom label wins. Verses are always numbered ("Strofa 1"); other types are
  // numbered only when the song has more than one of them ("Punte 1", "Punte 2").
  function sectionLabels(sections, t) {
    const totals = {};
    for (const s of sections) totals[s.type] = (totals[s.type] || 0) + 1;
    const seen = {};
    return sections.map((s) => {
      seen[s.type] = (seen[s.type] || 0) + 1;
      const custom = typeof s.label === 'string' ? s.label.trim() : '';
      if (custom) return custom;
      const name = t(`songs.sectionTypes.${s.type}`);
      if (s.type === 'verse' || totals[s.type] > 1) {
        return t('songs.sectionNumbered', { type: name, n: seen[s.type] });
      }
      return name;
    });
  }

  // --- section-name labels left in the lyrics ("Refren:" as the first line) -------------

  // Section names as they appear in imported / pasted lyrics (RO and EN), and the type each
  // names. A leading "Refren:" / "Strofa 2" / "Chorus /:" line says what the section type
  // already says.
  const LABEL_TYPES = {
    refren: 'chorus', chorus: 'chorus', cor: 'chorus',
    strofa: 'verse', 'strofă': 'verse', vers: 'verse', verse: 'verse',
    'pre-refren': 'pre_chorus', prerefren: 'pre_chorus', 'pre refren': 'pre_chorus', 'pre-chorus': 'pre_chorus', prechorus: 'pre_chorus', 'pre chorus': 'pre_chorus',
    punte: 'bridge', bridge: 'bridge',
    intro: 'intro',
    final: 'outro', outro: 'outro', coda: 'outro',
    'secțiune': 'other', sectiune: 'other', section: 'other',
  };
  const LABEL_WORDS = Object.keys(LABEL_TYPES).sort((a, b) => b.length - a.length).map((w) => w.replace(/[-\s]/g, '[-\\s]?'));
  // "/: Refren 2 :/", "Chorus:", "Strofa 1 /:" -> [whole, word, number, rest]
  const LABEL_RE = new RegExp(`^[\\s/:]*(${LABEL_WORDS.join('|')})\\.?\\s*(\\d{0,2})\\s*(?:[:/]+\\s*)?(.*)$`, 'i');

  // { type, rest } when the line starts with a section name (rest: what follows the label,
  // '' for a label-only line); null otherwise. A name followed by more words with no ":" /
  // "/:" between ("Intro duce lumina") is lyrics, not a label.
  function leadingLabel(line) {
    const m = LABEL_RE.exec(String(line || '').trim());
    if (!m) return null;
    const rest = m[3].trim();
    const separated = /[:/]\s*[^\s]*$/.test(m[0].slice(0, m[0].length - m[3].length)) || rest === '';
    if (!separated) return null;
    return { type: LABEL_TYPES[m[1].toLowerCase().replace(/\s+/g, ' ')] || 'other', rest };
  }

  // Drops a label-only first line ("Refren:", "Strofa 2") when it names `type`: the editor's
  // paste conversion. Everything else stays as it is; a section that is only the label keeps it.
  function stripLeadingLabel(content, type) {
    const lines = String(content || '').split('\n');
    const first = lines.findIndex((line) => line.trim());
    if (first < 0) return content;
    const label = leadingLabel(lines[first]);
    if (!label || label.rest || label.type !== type) return content;
    if (!lines.slice(first + 1).some((line) => line.trim())) return content;
    return lines.slice(first + 1).join('\n').replace(/^\n+/, '');
  }

  const SECTIONS = {
    SECTION_TYPES,
    normalizeType,
    leadingLabel,
    stripLeadingLabel,
    SONG_KEYS,
    sectionLabels,
  };

  root.SECTIONS = SECTIONS;
})(typeof window !== 'undefined' ? window : this);
