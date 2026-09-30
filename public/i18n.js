'use strict';

// SV-I18N-ALL — shared i18n for the team pages (worship, remote,
// operator-dashboard, landing). Admin has its own admin-i18n.js; participant
// keeps its 16-language end-user strings. Same LS key + data-i18n mechanism as
// admin-i18n.js, and it re-applies on the 'i18n:change' event the shell fires,
// so switching language in the "Mai mult" sheet updates every team page.
// Default language: ro (en/no complete; verified by scripts/check-i18n.js).
(function () {
  const LS_KEY = 'sanctuary_admin_ui_lang';

  const DICT = {
    ro: {},
    en: {},
    no: {},
  };

  // The dictionary is defined in i18n-dict.js (loaded before this file) so the
  // strings live in one readable place and the engine stays small.
  if (window.SV_I18N_DICT) {
    for (const lang of Object.keys(DICT)) {
      Object.assign(DICT[lang], window.SV_I18N_DICT[lang] || {});
    }
  }

  function getLang() {
    let saved = null;
    try {
      saved = localStorage.getItem(LS_KEY);
    } catch {
      /* no storage */
    }
    return saved && DICT[saved] ? saved : 'ro';
  }

  function t(key, lang) {
    const l = lang && DICT[lang] ? lang : getLang();
    const d = DICT[l] || DICT.ro;
    if (d[key] != null) return d[key];
    if (DICT.ro[key] != null) return DICT.ro[key];
    return key;
  }

  function apply(lang) {
    const l = DICT[lang] ? lang : getLang();
    const d = DICT[l] || DICT.ro;
    const set = (attr, fn) => {
      document.querySelectorAll('[' + attr + ']').forEach((el) => {
        const k = el.getAttribute(attr);
        if (d[k] != null) fn(el, d[k]);
        else if (DICT.ro[k] != null) fn(el, DICT.ro[k]);
      });
    };
    set('data-i18n', (el, v) => {
      el.textContent = v;
    });
    set('data-i18n-placeholder', (el, v) => el.setAttribute('placeholder', v));
    set('data-i18n-title', (el, v) => el.setAttribute('title', v));
    set('data-i18n-aria', (el, v) => el.setAttribute('aria-label', v));
    document.documentElement.setAttribute('lang', l);
    try {
      localStorage.setItem(LS_KEY, l);
    } catch {
      /* no storage */
    }
    document.querySelectorAll('.ui-lang-switch button').forEach((b) => {
      const selected = b.getAttribute('data-lang') === l;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function setLang(lang) {
    apply(lang);
    document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: getLang() } }));
  }

  // Re-apply when another surface (e.g. the shell's language switch) changes it.
  document.addEventListener('i18n:change', (e) => {
    const lang = e && e.detail && e.detail.lang;
    apply(lang || getLang());
  });

  // A page-level .ui-lang-switch, if present.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.ui-lang-switch button[data-lang]');
    if (btn) setLang(btn.getAttribute('data-lang'));
  });

  window.I18N = { t, apply, setLang, getLang, dict: DICT };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply(getLang()));
  } else {
    apply(getLang());
  }
})();
