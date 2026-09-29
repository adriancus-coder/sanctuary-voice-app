'use strict';

// SV-TOKENS-THEME — WCAG contrast of the theme colour tokens (public/styles.css):
// every text / background pair the UI uses must reach AA (4.5:1 for text, 3:1 for
// large text and focus rings) in both themes. Run by npm run check; --verbose
// prints the ratios.

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const tokens = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) tokens[m[1]] = m[2];
  return tokens;
}

const dark = block(':root');
const light = { ...dark, ...block(':root[data-theme="light"]') };

function rgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = 4.5;
const LARGE = 3; // large / bold text, focus rings
const PAIRS = [
  ['text', 'background', TEXT, 'body text'],
  ['text', 'surface', TEXT, 'text on cards'],
  ['text', 'surface-2', TEXT, 'text on raised areas'],
  ['text', 'accent-soft', TEXT, 'the current item'],
  ['text-muted', 'background', TEXT, 'hints'],
  ['text-muted', 'surface', TEXT, 'hints on cards'],
  ['text-muted', 'surface-2', TEXT, 'hints on raised areas'],
  ['on-accent', 'accent-fill', TEXT, 'primary buttons, selected options'],
  ['accent-text', 'background', TEXT, 'links, accent text'],
  ['accent-text', 'surface', TEXT, 'accent text on cards'],
  ['accent-text', 'accent-soft', TEXT, 'accent text on the current item'],
  ['chord', 'background', TEXT, 'chords'],
  ['chord', 'surface', TEXT, 'chords on cards'],
  ['error', 'background', TEXT, 'errors'],
  ['error', 'surface', TEXT, 'errors on cards'],
  ['success', 'background', TEXT, 'success'],
  ['success', 'surface', TEXT, 'success on cards'],
  ['warning', 'background', TEXT, 'warnings'],
  ['worship', 'background', TEXT, 'team position'],
  ['worship', 'surface', TEXT, 'team position on cards'],
  ['type-song', 'surface', TEXT, 'badge: song'],
  ['type-verse', 'surface', TEXT, 'badge: verse'],
  ['type-video', 'surface', TEXT, 'badge: video'],
  ['type-announcement', 'surface', TEXT, 'badge: announcement'],
  ['type-sermon', 'surface', TEXT, 'badge: sermon'],
  ['type-other', 'surface', TEXT, 'badge: other'],
  ['on-live', 'live-fill', TEXT, 'LIVE badge'],
  ['on-danger', 'danger-fill', TEXT, 'danger button'],
  ['focus', 'background', LARGE, 'focus ring'],
  ['focus', 'surface', LARGE, 'focus ring on cards'],
  ['projector-text', 'projector-bg', TEXT, 'projector'],
];

const verbose = process.argv.includes('--verbose');
const failures = [];
const lines = [];
for (const [name, tokens] of [
  ['dark', dark],
  ['light', light],
]) {
  for (const [fg, bg, min, what] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      failures.push(`${name}: missing --${fg} or --${bg}`);
      continue;
    }
    const r = ratio(tokens[fg], tokens[bg]);
    lines.push(
      `${name.padEnd(5)} ${`--${fg} on --${bg}`.padEnd(40)} ${r.toFixed(2).padStart(5)}:1 (min ${min}) ${what}`
    );
    if (r < min)
      failures.push(
        `${name}: --${fg} ${tokens[fg]} on --${bg} ${tokens[bg]} = ${r.toFixed(2)}:1 < ${min}:1 (${what})`
      );
  }
}
if (verbose) console.log(lines.join('\n'));
if (failures.length) {
  console.error(`check-contrast: ${failures.length} pair(s) below WCAG AA\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-contrast: ${PAIRS.length * 2} pairs meet WCAG AA in dark and light`);
