'use strict';

// Chord helpers for inline ChordPro content ("[G]Ne ridici din [D]noaptea grea").
// Ported (nearly verbatim) from worship-app public/chords.js for the shared song
// editor. Browser-only IIFE exposing window.CHORDS. Storage is always letters;
// solfège (Do Re Mi) is only for display and for pasted input.

(function (root) {
  // G, D/F#, Em7, Bbmaj7, Csus4, Am7b5, C(add9), E7#9, Gm/Bb, N.C.
  // Minor is written "m" only: "Amin" is the Romanian word (Amen), not A minor.
  const CHORD_RE = /^(?:N\.?C\.?|[A-G][#b]?(?:maj|m|dim|aug|sus|add|M|\+|°|ø)?(?:\d+|maj\d*|sus\d*|add\d+|dim\d*|aug|[#b]\d+|\(\w+\))*(?:\/[A-G][#b]?)?)$/;
  const INLINE_CHORD_RE = /\[([^\]\n]*)\]/g;

  // --- notation: letters (C D E) or Romanian solfège (Do Re Mi) ------------------------
  // Storage is always letters; solfège is for display and for pasted input.
  // C=Do D=Re E=Mi F=Fa G=Sol A=La B=Si; accidentals stay # / b, minor is glued (Lam, Fa#m).
  const SOLFEGE = { C: 'Do', D: 'Re', E: 'Mi', F: 'Fa', G: 'Sol', A: 'La', B: 'Si' };
  const LETTER = Object.fromEntries(Object.entries(SOLFEGE).map(([letter, name]) => [name, letter]));
  const SOLFEGE_CHORD_RE = /^(Do|Re|Mi|Fa|Sol|La|Si)([#b]?)(.*?)(?:\/(Do|Re|Mi|Fa|Sol|La|Si)([#b]?))?$/;
  const BARE_SYLLABLE_RE = /^(Do|Re|Mi|Fa|Sol|La|Si)$/;
  const NOTATIONS = ['letters', 'solfege'];

  // Capitalised solfège chord -> letters ("Fa#m7" -> "F#m7", "Re/Fa#" -> "D/F#"); anything
  // else (letters, lyrics such as "Mi-e" or "La-nceput") is returned unchanged.
  function fromSolfege(chord) {
    const text = String(chord);
    const m = SOLFEGE_CHORD_RE.exec(text);
    if (!m) return text;
    const letters = LETTER[m[1]] + m[2] + m[3] + (m[4] ? `/${LETTER[m[4]]}${m[5]}` : '');
    return CHORD_RE.test(letters) ? letters : text;
  }

  // A letter chord in the given notation ("F#m7" -> "Fa#m7" in solfège). N.C. and anything
  // that is not a letter chord are returned unchanged.
  function toNotation(chord, notation) {
    const text = String(chord);
    if (notation !== 'solfege' || !CHORD_RE.test(text) || /^N\.?C\.?$/.test(text)) return text;
    const m = CHORD_PARTS_RE.exec(text);
    if (!m) return text;
    return SOLFEGE[m[1]] + m[2] + m[3] + (m[4] ? `/${SOLFEGE[m[4]]}${m[5]}` : '');
  }

  function isChord(token) {
    return CHORD_RE.test(token) || fromSolfege(token) !== token;
  }

  // A line made only of chords (and optional "|" bar marks), with at least one chord.
  // Solfège syllables are also Romanian words: a line made only of bare capitalised
  // syllables ("La La La", "Do Re Mi") counts as chords only when laid out like a chord
  // line (a single chord, an indent, or chords spaced out by 2+ spaces). Lowercase words
  // ("la", "mi", "si") and joined forms ("Mi-e", "Si-am", "Do-mnul") are never chords.
  function isChordLine(line) {
    const text = String(line || '');
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const chords = tokens.filter((tok) => tok !== '|');
    if (!chords.length || !chords.every(isChord)) return false;
    if (!chords.every((tok) => BARE_SYLLABLE_RE.test(tok))) return true;
    return chords.length === 1 || /^\s/.test(text) || /\S\s{2,}\S/.test(text);
  }

  // Inline chords written in solfège ("[Sol]") -> letters ("[G]"); other brackets unchanged.
  function inlineToLetters(content) {
    return String(content || '').replace(INLINE_CHORD_RE, (match, chord) => {
      const trimmed = chord.trim();
      const letters = fromSolfege(trimmed);
      return letters !== trimmed ? `[${letters}]` : match;
    });
  }

  // Inline content for display: every chord in the notation.
  function renderContent(content, notation) {
    if (notation !== 'solfege') return String(content || '');
    return String(content || '').replace(INLINE_CHORD_RE, (match, chord) => {
      const trimmed = chord.trim();
      return trimmed ? `[${toNotation(trimmed, notation)}]` : match;
    });
  }

  // Lyrics only: chords removed, spaces left behind collapsed, chord-only lines dropped.
  function stripChords(content) {
    const out = [];
    for (const line of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
      const hadChords = /\[[^\]\n]*\]/.test(line);
      const text = line.replace(INLINE_CHORD_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
      if (hadChords && !text) continue;
      out.push(text);
    }
    return out.join('\n');
  }

  // Chords and their start columns in a chord line.
  function chordPositions(line) {
    const found = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m[0] !== '|') found.push({ col: m.index, chord: m[0] });
    }
    return found;
  }

  function insertChords(lyric, chords) {
    let text = lyric;
    const last = chords.length ? chords[chords.length - 1].col : 0;
    if (text.length < last) text = text.padEnd(last, ' ');
    for (let i = chords.length - 1; i >= 0; i--) {
      const { col, chord } = chords[i];
      text = `${text.slice(0, col)}[${fromSolfege(chord)}]${text.slice(col)}`; // stored as letters
    }
    return text;
  }

  // One chord line + one lyric line -> inline ChordPro, chords inserted at their columns.
  // The chord line is trusted as-is (e.g. OpenSong "." lines), even with unusual chord names.
  function mergeChordLine(chordLine, lyric) {
    return insertChords(lyric || '', chordPositions(chordLine)).trimEnd();
  }

  // "Chord line above lyric line" -> inline ChordPro, keeping chord columns.
  // A chord line without a lyric line below becomes an inline chord-only line.
  // Chords are stored as letters: solfège chords (above lyrics or inline) are converted.
  // Text that is already inline with letter chords (or has no chords) is returned unchanged.
  function chordsOverLyricsToInline(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').normalize('NFC').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isChordLine(line)) {
        out.push(inlineToLetters(line));
        continue;
      }
      const chords = chordPositions(line);
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && !isChordLine(next)) {
        out.push(insertChords(next, chords).trimEnd());
        i++;
      } else {
        out.push(insertChords('', chords).trimEnd());
      }
    }
    return out.join('\n');
  }

  // One inline line -> { chords, lyrics }: chords is a positioned chord line or null,
  // lyrics is the text or null for a chord-only line.
  function splitInlineLine(line) {
    let lyrics = '';
    let chordLine = '';
    let hasChords = false;
    let last = 0;
    let m;
    INLINE_CHORD_RE.lastIndex = 0;
    while ((m = INLINE_CHORD_RE.exec(line)) !== null) {
      lyrics += line.slice(last, m.index);
      last = m.index + m[0].length;
      const chord = m[1].trim();
      if (!chord) continue;
      hasChords = true;
      // Keep one space between neighbouring chords if they would touch.
      const col = Math.max(lyrics.length, chordLine.length ? chordLine.length + 1 : 0);
      chordLine = chordLine.padEnd(col, ' ') + chord;
    }
    lyrics += line.slice(last);
    return {
      chords: hasChords ? chordLine : null,
      lyrics: hasChords && !lyrics.trim() ? null : lyrics.trimEnd(),
    };
  }

  // For display: [{ chords, lyrics }] per content line.
  function inlineLinePairs(content) {
    return String(content || '').replace(/\r\n?/g, '\n').split('\n').map(splitInlineLine);
  }

  // Inline ChordPro -> "chord line above lyric line" text.
  function inlineToChordsOverLyrics(content) {
    const out = [];
    for (const { chords, lyrics } of inlineLinePairs(content)) {
      if (chords !== null) out.push(chords);
      if (lyrics !== null) out.push(lyrics);
    }
    return out.join('\n');
  }

  // --- transposition ---------------------------------------------------------

  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  // Keys written with flats; every other key uses sharps.
  const FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm'];
  const CHORD_PARTS_RE = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/;

  function noteIndex(letter, accidental) {
    return (NATURAL[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0) + 12) % 12;
  }

  function mod12(n) {
    return ((n % 12) + 12) % 12;
  }

  function usesFlats(key) {
    return FLAT_KEYS.includes(key);
  }

  // Display key after transposing, e.g. keyAfter('G', 2) -> 'A', keyAfter('C', 1) -> 'Db'.
  // The flat spelling is used when it is one of the flat keys, otherwise the sharp one.
  // null when the song has no (valid) key.
  function keyAfter(songKey, semitones) {
    const m = /^([A-G])([#b]?)(m?)$/.exec(String(songKey || ''));
    if (!m) return null;
    const index = mod12(noteIndex(m[1], m[2]) + (Number(semitones) || 0));
    const flat = FLAT_NAMES[index] + m[3];
    return usesFlats(flat) ? flat : SHARP_NAMES[index] + m[3];
  }

  // Degrees (semitones above the major tonic) that belong to the major scale.
  const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];

  // { tonic, flats, minor } for a key like 'G', 'Bb', 'F#m'; null when not a key.
  // A minor key is measured from its relative major (Am -> C).
  function parseKey(key) {
    const m = /^([A-G])([#b]?)(m?)$/.exec(String(key || ''));
    if (!m) return null;
    const minor = m[3] === 'm';
    return { tonic: mod12(noteIndex(m[1], m[2]) + (minor ? 3 : 0)), flats: usesFlats(key), minor };
  }

  // Name of a note in a key, by scale degree: diatonic notes use the key's own spelling
  // (sharp or flat family); chromatic b2, b3, b6, b7 use flats and #4 uses a sharp.
  // In a minor key the raised 7th (the leading tone, e.g. G# in Am) stays sharp.
  function spellNote(index, key) {
    const degree = mod12(index - key.tonic);
    if (MAJOR_DEGREES.includes(degree)) return (key.flats ? FLAT_NAMES : SHARP_NAMES)[index];
    if (degree === 6 || (degree === 8 && key.minor)) return SHARP_NAMES[index];
    return FLAT_NAMES[index];
  }

  // One chord, e.g. transposeChord('D/F#', 2, 'A') -> 'E/G#'. N.C. and anything that is not
  // a chord are returned unchanged. `spelling` is the target key (notes named by scale
  // degree), or a boolean: true = flats, false = sharps (used when there is no key).
  function transposeChord(chord, semitones, spelling) {
    const text = String(chord);
    const shift = mod12(Number(semitones) || 0);
    if (!shift || /^N\.?C\.?$/.test(text) || !isChord(text)) return text;
    const m = CHORD_PARTS_RE.exec(text);
    if (!m) return text;
    const key = typeof spelling === 'string' ? parseKey(spelling) : null;
    const names = spelling === true ? FLAT_NAMES : SHARP_NAMES;
    const name = (index) => (key ? spellNote(index, key) : names[index]);
    const root = name(mod12(noteIndex(m[1], m[2]) + shift));
    const bass = m[4] ? `/${name(mod12(noteIndex(m[4], m[5]) + shift))}` : '';
    return root + m[3] + bass;
  }

  // Inline ChordPro content with every chord moved by `semitones`, spelled for targetKey
  // (the key after transposing). A song without a key keeps plain sharps.
  function transposeContent(content, semitones, targetKey) {
    const shift = mod12(Number(semitones) || 0);
    if (!shift) return String(content || '');
    const spelling = parseKey(targetKey) ? targetKey : false;
    return String(content || '').replace(INLINE_CHORD_RE, (match, chord) => {
      const trimmed = chord.trim();
      return trimmed ? `[${transposeChord(trimmed, shift, spelling)}]` : match;
    });
  }

  const CHORDS = {
    NOTATIONS,
    toNotation,
    fromSolfege,
    renderContent,
    isChord,
    FLAT_KEYS,
    keyAfter,
    transposeChord,
    transposeContent,
    isChordLine,
    stripChords,
    chordsOverLyricsToInline,
    mergeChordLine,
    inlineToChordsOverLyrics,
    inlineLinePairs,
  };

  root.CHORDS = CHORDS;
})(typeof window !== 'undefined' ? window : this);
