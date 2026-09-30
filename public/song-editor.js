'use strict';

// SV-SONG-EDITOR — the shared song editor as a component, modelled on worship-app's
// public/song-editor.js but self-contained for Sanctuary Voice (no window.PAGE /
// NOTATION / SONG_RENDER dependency, and it works under BOTH i18n engines because the
// caller passes a translate function in at create()).
//
// A "Detalii" card (title, author, key with its value large in the reader's notation and a
// hint while empty, song language), the sections (type, custom label, text with chords in
// brackets or pasted chord-over-lyrics lines, a note; move / remove / add), and a live
// preview in the reader's notation with a "Doar text" toggle. Used by the admin console
// (Cântări) and /worship, so a song written during the service is edited exactly like one
// prepared at home. Saving is the caller's job (it reads editor.payload()).
//
//   const editor = SONG_EDITOR.create(container, { t, prefix, headingLevel, sourceLangSelect, extra })
//     editor.setSong(song)   // { title, author, key, sourceLang, sections:[{type,label,content,note}] }
//     editor.payload()       // { title, author, key, sourceLang, sections:[...] } (content is inline ChordPro)
//     editor.clear({ title }) // empty, optionally a prefilled title
//     editor.isDirty(); editor.markClean(); editor.focusTitle(); editor.onChange(cb)
//     editor.fields (title, author, key, sourceLang); editor.hasText()

(function (root) {
  const CHORDS = root.CHORDS;
  const SECTIONS = root.SECTIONS;

  // --- tiny DOM helper (inlined; SV has no window.PAGE.el) ---------------------
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'text') node.textContent = value;
        else if (key === 'class') node.className = value;
        else if (key === 'for') node.htmlFor = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
      }
    }
    for (const child of children.flat()) {
      if (child == null || child === false || child === '') continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // --- chord notation (letters / solfège), per-device, no server round-trip ----
  const NOTATION_KEY = 'sv_chord_notation';
  function readNotation() {
    try {
      const v = window.localStorage.getItem(NOTATION_KEY);
      return CHORDS.NOTATIONS.includes(v) ? v : 'letters';
    } catch {
      return 'letters';
    }
  }
  function writeNotation(value) {
    try {
      window.localStorage.setItem(NOTATION_KEY, value);
    } catch {
      /* private mode: stays for this page only */
    }
  }
  let notation = readNotation();
  // A chord / key shown in the current notation; content with its chords in the notation.
  const showChord = (chord) => (chord ? CHORDS.toNotation(chord, notation) : chord);
  const showContent = (content) => CHORDS.renderContent(content || '', notation);

  const emptySection = () => ({ type: 'verse', label: '', content: '', note: '' });

  function create(container, options = {}) {
    const t = typeof options.t === 'function' ? options.t : (key) => key;
    // Interpolate {name} placeholders from the raw template both i18n engines return.
    const tr = (key, vars) => {
      const str = String(t(key));
      return vars ? str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : str;
    };

    const p = options.prefix || 'se';
    const ids = { title: `${p}-title`, author: `${p}-author`, key: `${p}-key`, sections: `${p}-sections-editor`, addSection: `${p}-add-section`, preview: `${p}-preview`, ...(options.ids || {}) };
    const sectionPrefix = options.sectionPrefix || `${p}-section`;
    const h = `h${options.headingLevel || 2}`;
    const state = { sections: [emptySection()], base: '' };
    const listeners = [];
    const changed = () => { for (const cb of listeners) cb(); };

    // --- markup ---
    const titleInput = el('input', { type: 'text', id: ids.title, maxlength: '200', required: true, oninput: changed });
    const authorInput = el('input', { type: 'text', id: ids.author, maxlength: '200', oninput: changed });
    const keySelect = el('select', { id: ids.key, onchange: changed });
    // SV keeps its existing source-language control: the caller may hand one in.
    const sourceLangSelect = options.sourceLangSelect || el('select', { id: ids.sourceLang || `${p}-source-lang` });
    const sectionsBox = el('div', { id: ids.sections, class: 'sections-editor' });
    const addButton = el('button', { type: 'button', id: ids.addSection, class: 'btn btn-dark', 'data-icon': 'plus' });
    const preview = el('div', { id: ids.preview, class: 'song-editor-preview' });
    const labels = {
      details: el(h, { id: `${ids.key}-details-heading` }),
      title: el('label', { for: ids.title }),
      author: el('label', { for: ids.author }),
      key: el('label', { for: ids.key }),
      lang: el('label', { for: sourceLangSelect.id }),
      sections: el(h),
      preview: el(h, { id: `${ids.preview}-heading` }),
    };
    // The key row: the current value large in the reader's notation next to the picker, and a
    // hint while it is empty ("Adaugă tonul ca să poți transpune").
    const keyValue = el('output', { class: 'song-key-value editor-key-value', for: ids.key, 'aria-live': 'polite' });
    const keyHint = el('span', { class: 'hint editor-key-hint', id: `${ids.key}-hint` });
    keySelect.setAttribute('aria-describedby', keyHint.id);

    // "Doar text" toggle + notation switch, above the preview.
    const textOnlyToggle = el('button', { type: 'button', class: 'btn btn-light song-editor-textonly', 'aria-pressed': 'false', onclick: () => { previewTextOnly = !previewTextOnly; renderTextOnlyToggle(); renderPreview(); } });
    let previewTextOnly = false;
    const notationSwitch = buildNotationSwitch();

    container.classList.add('song-editor');
    container.replaceChildren(
      el('section', { class: 'editor-details', 'aria-labelledby': labels.details.id },
        labels.details,
        el('div', { class: 'field' }, labels.title, titleInput),
        el('div', { class: 'field' }, labels.author, authorInput),
        el('div', { class: 'field editor-key-field' }, labels.key,
          el('div', { class: 'editor-key-row' }, keyValue, keySelect),
          keyHint),
        options.hideSourceLang ? '' : el('div', { class: 'field' }, labels.lang, sourceLangSelect)),
      options.extra || '',
      labels.sections,
      sectionsBox,
      addButton,
      el('section', { class: 'editor-preview', 'aria-labelledby': `${ids.preview}-heading` },
        el('div', { class: 'editor-preview-head' }, labels.preview,
          el('div', { class: 'editor-preview-tools' }, textOnlyToggle, notationSwitch)),
        preview));

    // "C · Do": two buttons, the current notation pressed.
    function buildNotationSwitch() {
      const group = el('span', { class: 'notation-switch', role: 'group' });
      for (const [value, text] of [['letters', 'C'], ['solfege', 'Do']]) {
        group.append(el('button', {
          type: 'button', class: 'btn btn-light', 'data-value': value, text,
          'aria-pressed': String(value === notation),
          onclick: () => setNotation(value),
        }));
      }
      return group;
    }
    function renderNotationSwitch() {
      notationSwitch.setAttribute('aria-label', tr('editor.notationLabel'));
      for (const button of notationSwitch.querySelectorAll('button')) {
        const on = button.dataset.value === notation;
        button.setAttribute('aria-pressed', String(on));
        button.classList.toggle('on', on);
        button.title = tr(`editor.notation.${button.dataset.value}`);
      }
    }
    function setNotation(value) {
      if (!CHORDS.NOTATIONS.includes(value) || value === notation) return;
      notation = value;
      writeNotation(value);
      renderNotationSwitch();
      renderKeys();
      renderPreview();
      document.dispatchEvent(new CustomEvent('notation:change', { detail: { notation: value } }));
    }

    function renderTextOnlyToggle() {
      textOnlyToggle.textContent = tr('editor.textOnly');
      textOnlyToggle.setAttribute('aria-pressed', String(previewTextOnly));
      textOnlyToggle.classList.toggle('on', previewTextOnly);
    }

    function renderKeys() {
      const value = keySelect.value;
      keySelect.replaceChildren(
        el('option', { value: '', text: tr('editor.keyNone') }),
        // Shown in the reader's notation (Sol, Lam); the value stays the letter key.
        ...SECTIONS.SONG_KEYS.map((key) => el('option', { value: key, text: showChord(key) })));
      keySelect.value = value;
      renderKeyValue();
    }

    function renderKeyValue() {
      const key = keySelect.value;
      keyValue.textContent = key ? showChord(key) : tr('editor.keyNone');
      keyValue.classList.toggle('song-key-unset-text', !key);
      keyHint.textContent = key ? '' : tr('editor.keyHint');
      keyHint.hidden = Boolean(key);
    }
    keySelect.addEventListener('change', renderKeyValue);

    function field(id, labelText, control, hint) {
      return el('div', { class: 'field' },
        el('label', { for: id, text: labelText }),
        control,
        hint ? el('span', { class: 'hint', id: `${id}-hint`, text: hint }) : null);
    }

    const rowsFor = (content) => Math.min(16, Math.max(4, String(content).split('\n').length + 1));

    // Updates the computed labels without rebuilding the form (keeps focus while typing).
    function refreshLabels() {
      const names = SECTIONS.sectionLabels(state.sections, tr);
      sectionsBox.querySelectorAll('.section-editor').forEach((fieldset, i) => {
        fieldset.querySelector('legend').textContent = names[i];
        fieldset.querySelector('[data-action="up"]').setAttribute('aria-label', tr('editor.moveUp', { label: names[i] }));
        fieldset.querySelector('[data-action="down"]').setAttribute('aria-label', tr('editor.moveDown', { label: names[i] }));
        fieldset.querySelector('[data-action="remove"]').setAttribute('aria-label', tr('editor.removeSection', { label: names[i] }));
      });
    }

    function toolButton(action, index, symbol, disabled) {
      return el('button', {
        type: 'button', class: 'btn btn-light icon-button', 'data-action': action, 'data-index': index, disabled,
        onclick: () => onTool(action, index),
      }, el('span', { 'aria-hidden': 'true', text: symbol }));
    }

    function renderSections() {
      schedulePreview(); // sections added, removed or moved
      const count = state.sections.length;
      sectionsBox.replaceChildren(...state.sections.map((section, i) => {
        const id = `${sectionPrefix}-${i}`;
        const typeSelect = el('select', {
          id: `${id}-type`,
          onchange: (event) => { section.type = event.target.value; refreshLabels(); changed(); },
        }, SECTIONS.SECTION_TYPES.map((type) => el('option', { value: type, text: tr(`songs.sectionTypes.${type}`) })));
        typeSelect.value = section.type;
        const content = el('textarea', {
          id: `${id}-content`, class: 'mono song-section-textarea', rows: rowsFor(section.content), spellcheck: 'false', autocapitalize: 'sentences',
          'aria-describedby': `${id}-content-hint`,
          oninput: (event) => { section.content = event.target.value; changed(); },
          // Pasting a whole lyric with blank lines into the fresh (single empty) editor splits
          // it into sections; each section's type is inferred from a leading label.
          onpaste: (event) => {
            if (state.sections.length !== 1 || state.sections[0].content.trim()) return;
            const clip = (event.clipboardData || window.clipboardData);
            const pasted = clip ? clip.getData('text') : '';
            const split = splitPastedSections(pasted);
            if (!split) return;
            event.preventDefault();
            state.sections = split;
            renderSections();
            sectionsBox.querySelector(`#${sectionPrefix}-0-content`)?.focus();
            changed();
          },
          // Pasted "chord line above lyric line" text becomes inline ChordPro; a label-only
          // first line ("Refren:") that the section type already says is dropped.
          onblur: (event) => {
            const converted = SECTIONS.stripLeadingLabel(CHORDS.chordsOverLyricsToInline(event.target.value), section.type);
            if (converted !== event.target.value) {
              event.target.value = converted;
              section.content = converted;
              changed();
            }
          },
        });
        content.value = section.content;
        return el('fieldset', { class: 'section-editor' },
          el('legend'),
          el('div', { class: 'section-fields' },
            field(`${id}-type`, tr('editor.typeLabel'), typeSelect),
            field(`${id}-label`, tr('editor.customLabel'), el('input', {
              type: 'text', id: `${id}-label`, maxlength: '60', value: section.label || '',
              oninput: (event) => { section.label = event.target.value; refreshLabels(); changed(); },
            }))),
          field(`${id}-content`, tr('editor.contentLabel'), content, tr('editor.contentHint')),
          field(`${id}-note`, tr('editor.noteLabel'), el('input', {
            type: 'text', id: `${id}-note`, maxlength: '300', value: section.note || '',
            oninput: (event) => { section.note = event.target.value; changed(); },
          })),
          el('div', { class: 'section-tools' },
            toolButton('up', i, '↑', i === 0),
            toolButton('down', i, '↓', i === count - 1),
            toolButton('remove', i, '✕', count === 1)));
      }));
      refreshLabels();
    }

    function focusTool(action, index) {
      const target = sectionsBox.querySelector(`[data-action="${action}"][data-index="${index}"]`);
      if (target && !target.disabled) target.focus();
      else sectionsBox.querySelector(`#${sectionPrefix}-${index}-type`)?.focus();
    }

    function onTool(action, index) {
      const list = state.sections;
      if (action === 'up' && index > 0) {
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
        renderSections();
        focusTool('up', index - 1);
      } else if (action === 'down' && index < list.length - 1) {
        [list[index + 1], list[index]] = [list[index], list[index + 1]];
        renderSections();
        focusTool('down', index + 1);
      } else if (action === 'remove' && list.length > 1) {
        list.splice(index, 1);
        renderSections();
        focusTool('remove', Math.min(index, list.length - 1));
      } else return;
      changed();
    }

    // Live preview of the sections as they will be shown (chords in the reader's notation,
    // or lyrics only when "Doar text" is pressed).
    let previewTimer = null;
    function renderPreview() {
      clearTimeout(previewTimer);
      const names = SECTIONS.sectionLabels(state.sections, tr);
      const shown = state.sections
        .map((s, i) => ({ section: s, label: names[i] }))
        .filter(({ section }) => section.content && section.content.trim());
      if (!shown.length) {
        preview.replaceChildren(el('p', { class: 'muted', text: tr('editor.previewEmpty') }));
        return;
      }
      preview.replaceChildren(...shown.map(({ section, label }) => {
        const inline = CHORDS.chordsOverLyricsToInline(section.content);
        const body = previewTextOnly
          ? el('p', { class: 'lyrics', text: CHORDS.stripChords(inline) })
          : chordSheet(inline);
        return el('section', { class: 'song-section' },
          el(`h${(options.headingLevel || 2) + 1}`, { class: 'section-label', text: label }),
          section.note ? el('p', { class: 'section-note', text: section.note }) : null,
          body);
      }));
    }
    function chordSheet(content) {
      const lines = [];
      for (const { chords, lyrics } of CHORDS.inlineLinePairs(showContent(content))) {
        if (chords !== null) lines.push(el('span', { class: 'chord-line', text: chords }));
        if (lyrics !== null) lines.push(el('span', { class: 'lyric-line', text: lyrics || ' ' }));
      }
      return el('div', { class: 'chord-sheet' }, lines);
    }
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 200);
    }
    container.addEventListener('input', schedulePreview);
    container.addEventListener('change', schedulePreview);
    addButton.addEventListener('click', () => {
      state.sections.push(emptySection());
      renderSections();
      sectionsBox.querySelector(`#${sectionPrefix}-${state.sections.length - 1}-type`).focus();
      changed();
    });

    function renderTexts() {
      labels.details.textContent = tr('editor.detailsHeading');
      labels.title.textContent = tr('editor.titleLabel');
      labels.author.textContent = tr('editor.authorLabel');
      labels.key.textContent = tr('editor.keyLabel');
      labels.lang.textContent = tr('editor.langLabel');
      labels.sections.textContent = tr('editor.sectionsHeading');
      labels.preview.textContent = tr('editor.previewHeading');
      addButton.textContent = tr('editor.addSection');
      renderTextOnlyToggle();
      renderNotationSwitch();
    }

    function render() {
      renderTexts();
      renderKeys();
      renderSections();
      renderPreview();
    }

    // Splits pasted lyrics into sections on blank lines, inferring each section's type from a
    // leading label ("Refren:", "Strofa 2") when present. Chord-over-lyrics stays as pasted
    // here; the per-section textarea converts it to inline ChordPro on blur.
    function splitPastedSections(text) {
      const blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter((b) => b.trim());
      if (blocks.length < 2) return null;
      return blocks.map((block) => {
        const label = SECTIONS.leadingLabel(block.split('\n').find((l) => l.trim()) || '');
        const type = label ? label.type : 'verse';
        return { type, label: '', content: SECTIONS.stripLeadingLabel(block, type), note: '' };
      });
    }

    function payload() {
      return {
        title: titleInput.value.trim(),
        author: authorInput.value.trim(),
        key: keySelect.value,
        sourceLang: sourceLangSelect.value || '',
        sections: state.sections.map((s) => ({
          type: SECTIONS.normalizeType(s.type),
          label: String(s.label || '').trim(),
          content: CHORDS.chordsOverLyricsToInline(s.content),
          note: String(s.note || '').trim(),
        })),
      };
    }
    const snapshot = () => JSON.stringify(payload());

    function setSong(song) {
      const s = song || {};
      state.sections = s.sections && s.sections.length
        ? s.sections.map((x) => ({ type: SECTIONS.normalizeType(x.type || 'verse'), label: x.label || '', content: x.content || '', note: x.note || '' }))
        : [emptySection()];
      titleInput.value = s.title || '';
      authorInput.value = s.author || '';
      renderKeys();
      keySelect.value = s.key || '';
      renderKeyValue();
      if (s.sourceLang && sourceLangSelect.querySelector(`option[value="${s.sourceLang}"]`)) {
        sourceLangSelect.value = s.sourceLang;
      }
      render();
      state.base = snapshot();
    }

    document.addEventListener('notation:change', (e) => {
      const next = e && e.detail && e.detail.notation;
      if (next && CHORDS.NOTATIONS.includes(next) && next !== notation) {
        notation = next;
        renderNotationSwitch();
        renderKeys();
        renderPreview();
      }
    });
    // Re-render every label when the surface's language changes (admin and /worship use
    // different i18n engines, so the caller names the event it fires).
    if (options.i18nEvent) document.addEventListener(options.i18nEvent, render);
    setSong(null);

    return {
      setSong,
      payload,
      splitPastedSections,
      loadPastedSections: (text) => {
        const sections = splitPastedSections(text);
        if (sections) { state.sections = sections; renderSections(); changed(); return true; }
        return false;
      },
      isDirty: () => snapshot() !== state.base,
      markClean: () => { state.base = snapshot(); },
      clear(prefill = {}) { setSong({ title: prefill.title || '' }); },
      focusTitle: () => titleInput.focus(),
      onChange: (cb) => listeners.push(cb),
      render,
      fields: { title: titleInput, author: authorInput, key: keySelect, sourceLang: sourceLangSelect },
      hasText: () => Boolean(titleInput.value.trim() || state.sections.some((s) => s.content.trim())),
    };
  }

  root.SONG_EDITOR = { create };
})(typeof window !== 'undefined' ? window : this);
