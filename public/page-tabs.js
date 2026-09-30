'use strict';

// SV-PAGE-TABS — a sticky, in-page segmented tab bar + a sticky action bar.
// Layout only: it shows/hides existing sections, it never moves data or changes
// any socket/display behaviour. Declarative via data attributes:
//
//   <nav class="page-tabs" data-page-tabs="dashTabs"
//        data-tabs='[{"id":"live","label":"Live","i18n":"tabs.live"}, ...]'></nav>
//   <section class="page-tab-panel" data-tab-for="dashTabs" data-tab="live"> ... </section>
//   <section class="page-tab-panel" data-tab-for="dashTabs" data-tab="afisaj"> ... </section>
//
// Active tab is kept in the URL hash (#dashTabs=live) and remembered per bar per
// device (localStorage). Keyboard: Left/Right/Home/End move between tabs.
// Badges: PageTabs.setBadge(barId, tabId, text).
(function () {
  const bars = new Map(); // barId -> { nav, tabs:[{id,label,i18n,badge}], panels: Map(tabId->[el]), active }

  function storeKey(barId) { return 'sv-tabs:' + barId; }

  function resolveLabel(entry) {
    const key = entry.i18n;
    if (key) {
      try {
        if (window.adminI18n && window.adminI18n.dict) {
          const lang = window.adminI18n.get ? window.adminI18n.get() : 'ro';
          const v = window.adminI18n.dict[lang] && window.adminI18n.dict[lang][key];
          if (v != null) return v;
        }
        if (window.I18N && typeof window.I18N.t === 'function') {
          const v = window.I18N.t(key);
          if (v && v !== key) return v;
        }
      } catch { /* fall through to label */ }
    }
    return entry.label || entry.id;
  }

  function reapplyI18n() {
    try {
      if (window.adminI18n && window.adminI18n.apply) window.adminI18n.apply(window.adminI18n.get());
      else if (window.I18N && window.I18N.apply) window.I18N.apply();
    } catch { /* best effort */ }
  }

  function readInitial(barId, tabs) {
    // 1) URL hash (#barId=tabId), 2) remembered per device, 3) first tab.
    try {
      const m = new RegExp('(?:^|&|#)' + barId + '=([^&]+)').exec(location.hash || '');
      if (m && tabs.some((t) => t.id === decodeURIComponent(m[1]))) return decodeURIComponent(m[1]);
    } catch { /* ignore */ }
    try {
      const saved = localStorage.getItem(storeKey(barId));
      if (saved && tabs.some((t) => t.id === saved)) return saved;
    } catch { /* ignore */ }
    return tabs[0] && tabs[0].id;
  }

  function writeHash(barId, tabId) {
    // Keep other bars' hash segments; replace this bar's, without a history entry.
    try {
      const raw = (location.hash || '').replace(/^#/, '');
      const parts = raw.split('&').filter((p) => p && !p.startsWith(barId + '='));
      parts.push(barId + '=' + encodeURIComponent(tabId));
      const next = '#' + parts.join('&');
      history.replaceState(null, '', location.pathname + location.search + next);
    } catch { /* ignore */ }
  }

  function activate(barId, tabId, { updateHash = true } = {}) {
    const bar = bars.get(barId);
    if (!bar) return;
    if (!bar.panels.has(tabId)) tabId = bar.tabs[0] && bar.tabs[0].id;
    bar.active = tabId;
    bar.tabs.forEach((t) => {
      const btn = bar.nav.querySelector('[data-tab-btn="' + t.id + '"]');
      if (btn) {
        const on = t.id === tabId;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      }
      (bar.panels.get(t.id) || []).forEach((el) => { el.hidden = t.id !== tabId; });
    });
    if (updateHash) writeHash(barId, tabId);
    try { localStorage.setItem(storeKey(barId), tabId); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('page-tab:change', { detail: { barId, tabId } }));
    // Re-measure any sticky action bar now visible.
    updateStickyOffsets();
  }

  function buildBar(nav) {
    const barId = nav.getAttribute('data-page-tabs');
    if (!barId || bars.has(barId)) return;
    let tabs = [];
    try { tabs = JSON.parse(nav.getAttribute('data-tabs') || '[]'); } catch { tabs = []; }
    if (!tabs.length) return;

    const panels = new Map();
    document.querySelectorAll('[data-tab-for="' + barId + '"]').forEach((el) => {
      const id = el.getAttribute('data-tab');
      if (!id) return;
      if (!panels.has(id)) panels.set(id, []);
      panels.get(id).push(el);
    });

    nav.setAttribute('role', 'tablist');
    nav.innerHTML = tabs.map((t) => {
      const i18nAttr = t.i18n ? ' data-i18n="' + t.i18n + '"' : '';
      return '<button type="button" class="page-tab" role="tab" data-tab-btn="' + t.id + '"'
        + ' aria-selected="false" tabindex="-1"' + i18nAttr + '>'
        + '<span class="page-tab-label">' + escapeHtml(resolveLabel(t)) + '</span>'
        + '<span class="page-tab-badge" data-tab-badge="' + t.id + '" hidden></span>'
        + '</button>';
    }).join('');

    bars.set(barId, { nav, tabs, panels, active: null });

    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab-btn]');
      if (btn) activate(barId, btn.getAttribute('data-tab-btn'));
    });
    nav.addEventListener('keydown', (e) => {
      const ids = tabs.map((t) => t.id);
      const cur = ids.indexOf(bars.get(barId).active);
      let next = -1;
      if (e.key === 'ArrowRight') next = (cur + 1) % ids.length;
      else if (e.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ids.length - 1;
      if (next >= 0) {
        e.preventDefault();
        activate(barId, ids[next]);
        const btn = nav.querySelector('[data-tab-btn="' + ids[next] + '"]');
        if (btn) btn.focus();
      }
    });

    activate(barId, readInitial(barId, tabs), { updateHash: false });
  }

  function setBadge(barId, tabId, text) {
    const bar = bars.get(barId);
    if (!bar) return;
    const el = bar.nav.querySelector('[data-tab-badge="' + tabId + '"]');
    if (!el) return;
    const val = (text == null || text === '' || text === 0 || text === '0') ? '' : String(text);
    el.textContent = val;
    el.hidden = !val;
  }

  // --- Sticky action bar: keep content clear of the pinned bar. ---
  function updateStickyOffsets() {
    let h = 0;
    document.querySelectorAll('[data-sticky-actions]').forEach((el) => {
      // A hidden bar (display:none / [hidden]) has no client rects — skip it.
      // Do NOT gate on offsetParent: a position:fixed bar always reports
      // offsetParent === null even while visible, which used to leave
      // --sticky-actions-h stuck at 0 and let the bar cover the last rows.
      if (el.getClientRects().length === 0) return;
      h = Math.max(h, el.offsetHeight);
    });
    const root = document.documentElement.style;
    root.setProperty('--sticky-actions-h', h ? h + 'px' : '0px');
    // 16px clearance between the last content and the bar — only when a bar shows,
    // so tabs/pages without a sticky bar keep no phantom bottom padding.
    root.setProperty('--sticky-actions-gap', h ? '16px' : '0px');
  }

  // Re-measure whenever a sticky bar changes size or shows/hides (tab switch,
  // top-nav switch, wrapping to a new row, …). ResizeObserver reports a 0 rect
  // when an element becomes display:none, so this covers show/hide from any cause.
  let stickyRO = null;
  function observeStickyBars(root) {
    if (typeof ResizeObserver !== 'function') return;
    if (!stickyRO) stickyRO = new ResizeObserver(() => updateStickyOffsets());
    (root || document).querySelectorAll('[data-sticky-actions]').forEach((el) => stickyRO.observe(el));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function init(root) {
    (root || document).querySelectorAll('[data-page-tabs]').forEach(buildBar);
    reapplyI18n();
    observeStickyBars(root);
    updateStickyOffsets();
  }

  // React to language changes (labels via data-i18n are re-translated by the engine).
  document.addEventListener('i18n:change', () => setTimeout(updateStickyOffsets, 0));
  window.addEventListener('resize', updateStickyOffsets);
  window.addEventListener('hashchange', () => {
    bars.forEach((bar, barId) => {
      const m = new RegExp('(?:^|&|#)' + barId + '=([^&]+)').exec(location.hash || '');
      if (m) { const id = decodeURIComponent(m[1]); if (bar.panels.has(id) && id !== bar.active) activate(barId, id, { updateHash: false }); }
    });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }

  window.PageTabs = { init, activate, setBadge, updateStickyOffsets };
})();
