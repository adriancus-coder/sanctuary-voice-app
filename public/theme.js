'use strict';

// SV-TOKENS-THEME — the colour theme, applied before first paint. Loaded in
// <head> (not deferred) on the app pages. Preference is stored in localStorage
// ('sv-theme-pref' = dark | light | auto); 'auto' follows the device via
// prefers-color-scheme and updates live. data-theme on <html> selects the
// palette in styles.css. The projector page keeps its own display theme.
//
//   window.THEME.set('light')   // apply + persist a preference
//   window.THEME.pref / .current
//   document 'theme:change' { detail: { pref, theme } }
(function () {
  const root = document.documentElement;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const KEY = 'sv-theme-pref';
  const valid = (v) => v === 'dark' || v === 'light' || v === 'auto';

  function storedPref() {
    try {
      const v = window.localStorage.getItem(KEY);
      if (valid(v)) return v;
    } catch {
      /* no storage */
    }
    return valid(root.dataset.themePref) ? root.dataset.themePref : 'dark';
  }

  const prefOf = () => (valid(root.dataset.themePref) ? root.dataset.themePref : 'dark');
  const resolve = (pref) => (pref === 'auto' ? (media && media.matches ? 'light' : 'dark') : pref);

  function apply() {
    const pref = prefOf();
    const theme = resolve(pref);
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const color = getComputedStyle(root).getPropertyValue('--background').trim();
      if (color) meta.setAttribute('content', color);
    }
    if (changed) document.dispatchEvent(new CustomEvent('theme:change', { detail: { pref, theme } }));
  }

  root.dataset.themePref = storedPref();
  apply();

  if (media) {
    const onChange = () => {
      if (prefOf() === 'auto') apply();
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  window.THEME = {
    set(pref) {
      if (!valid(pref)) return;
      root.dataset.themePref = pref;
      try {
        window.localStorage.setItem(KEY, pref);
      } catch {
        /* no storage */
      }
      apply();
    },
    get pref() {
      return prefOf();
    },
    get current() {
      return root.dataset.theme;
    },
  };
})();
