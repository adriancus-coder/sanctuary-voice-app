'use strict';

// SV-APP-SHELL — shared cross-page navigation. Bottom tab bar on phones, left
// rail >=900px, plus a "Mai mult" sheet (language, theme, screens, sign out).
// Opt in per page with <body data-shell="home|events|songs|translate">; a
// full-screen work page uses <body data-shell="exit" data-shell-exit="/back">
// to get only a small "‹ Ieși" link. Account-aware nav filtering arrives with
// the accounts commits; today the shell needs no backend.
//
// The admin console keeps its own in-page tabs; the shell only jumps between
// the main surfaces. "Evenimente" and "Traducere" both open /admin (events tab
// and the live-control dashboard) via a #hash the shell activates.
(function () {
  const body = document.body;
  const section = body.dataset.shell;
  if (!section) return;

  const LS_LANG = 'sanctuary_admin_ui_lang';
  const LABELS = {
    ro: {
      home: 'Acasă', events: 'Evenimente', songs: 'Cântări', translate: 'Traducere', more: 'Mai mult',
      nav: 'Navigare', prefs: 'Preferințe', lang: 'Limbă', theme: 'Temă', screens: 'Ecrane',
      account: 'Cont', team: 'Echipa', logout: 'Deconectare', projector: 'Ecran principal', remote: 'Telecomandă',
      adminTools: 'Admin', stats: 'Statistici', quickText: 'Text rapid',
      mainScreen: 'Ecran principal', roles: 'Roluri', glossary: 'Glosar', settings: 'Setări',
      dark: 'Întunecat', light: 'Luminos', auto: 'Auto', exit: 'Ieși', close: 'Închide',
    },
    en: {
      home: 'Home', events: 'Events', songs: 'Songs', translate: 'Translation', more: 'More',
      nav: 'Navigation', prefs: 'Preferences', lang: 'Language', theme: 'Theme', screens: 'Screens',
      account: 'Account', team: 'Team', logout: 'Sign out', projector: 'Main screen', remote: 'Remote',
      adminTools: 'Admin', stats: 'Statistics', quickText: 'Quick text',
      mainScreen: 'Main screen', roles: 'Roles', glossary: 'Glossary', settings: 'Settings',
      dark: 'Dark', light: 'Light', auto: 'Auto', exit: 'Exit', close: 'Close',
    },
    no: {
      home: 'Hjem', events: 'Hendelser', songs: 'Sanger', translate: 'Oversettelse', more: 'Mer',
      nav: 'Navigasjon', prefs: 'Innstillinger', lang: 'Språk', theme: 'Tema', screens: 'Skjermer',
      account: 'Konto', team: 'Team', logout: 'Logg ut', projector: 'Hovedskjerm', remote: 'Fjernkontroll',
      adminTools: 'Admin', stats: 'Statistikk', quickText: 'Hurtigtekst',
      mainScreen: 'Hovedskjerm', roles: 'Roller', glossary: 'Ordliste', settings: 'Innstillinger',
      dark: 'Mørk', light: 'Lys', auto: 'Auto', exit: 'Avslutt', close: 'Lukk',
    },
  };
  function lang() {
    try {
      const l = localStorage.getItem(LS_LANG);
      if (LABELS[l]) return l;
    } catch {
      /* no storage */
    }
    const h = document.documentElement.lang;
    return LABELS[h] ? h : 'ro';
  }
  const t = (k) => (LABELS[lang()] || LABELS.ro)[k] || k;

  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    events: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    songs: svg('<path d="M9 18V5l10-2v11"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="14" r="3"/>'),
    translate: svg('<path d="M4 5h9M9 3v2M11 5c0 4-3 7-7 8M7 8c1 2 3 4 6 5"/><path d="M14 20l4-9 4 9M15.5 17h5"/>'),
    more: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
    projector: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    remote: svg('<rect x="7" y="2" width="10" height="20" rx="3"/><path d="M12 6v3"/><circle cx="12" cy="14" r="1.4"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
    team: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>'),
    stats: svg('<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/>'),
    quickText: svg('<path d="M4 5h16M4 10h16M4 15h10"/>'),
    mainScreen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    roles: svg('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),
    glossary: svg('<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M9 7h6M9 11h6"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.2A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.2A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V1a2 2 0 0 1 4 0v.2A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H23a2 2 0 0 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/>'),
    exit: svg('<path d="M15 18l-6-6 6-6"/>'),
  };

  // SV-SHELL-DRIVES-ADMIN — on the admin console the shell is the ONLY navigation,
  // so its four primary entries drive the admin's in-page views via #hash (handled
  // by routeAdminHash in app.js); "Traducere" lands on the dashboard's Live tab.
  const onAdmin = location.pathname.startsWith('/admin');
  const NAV = onAdmin
    ? [
        { id: 'home', href: '#dashboard' },
        { id: 'events', href: '#events' },
        { id: 'songs', href: '#song', badge: 'adminSongTabBadge' },
        { id: 'translate', href: '#dashTabs=live' },
      ]
    : [
        { id: 'home', href: '/' },
        { id: 'events', href: '/admin#events' },
        { id: 'songs', href: '/worship' },
        { id: 'translate', href: '/admin#dashboard' },
      ];

  // --- exit-only mode (full-screen work pages) ---
  if (section === 'exit') {
    const a = document.createElement('a');
    a.className = 'shell-exit';
    a.href = body.dataset.shellExit || '/';
    a.innerHTML = `${ICON.exit}<span>${t('exit')}</span>`;
    body.prepend(a);
    body.classList.add('has-shell-exit');
    return;
  }

  // --- full shell ---
  body.classList.add('has-shell');

  const nav = document.createElement('nav');
  nav.className = 'sv-appnav';
  nav.id = 'sv-appnav';
  nav.setAttribute('aria-label', t('more'));
  const ul = document.createElement('ul');
  ul.className = 'shell-list';
  for (const item of NAV) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'shell-item';
    a.href = item.href;
    a.dataset.section = item.id;
    if (item.id === section) a.setAttribute('aria-current', 'page');
    const badge = item.badge
      ? `<span class="tab-badge hidden shell-badge" id="${item.badge}" aria-label="cerere worship în așteptare"></span>`
      : '';
    a.innerHTML = `<span class="shell-icon">${ICON[item.id]}${badge}</span><span class="shell-label">${t(item.id)}</span>`;
    li.appendChild(a);
    ul.appendChild(li);
  }
  const moreLi = document.createElement('li');
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'shell-item shell-more';
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.setAttribute('aria-controls', 'shell-panel');
  moreBtn.innerHTML = `<span class="shell-icon">${ICON.more}</span><span class="shell-label">${t('more')}</span>`;
  moreLi.appendChild(moreBtn);
  ul.appendChild(moreLi);
  nav.appendChild(ul);
  body.prepend(nav);

  const backdrop = document.createElement('div');
  backdrop.className = 'shell-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'shell-panel';
  panel.id = 'shell-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="shell-handle" aria-hidden="true"></div>
    <header class="shell-panel-head">
      <h2 class="shell-panel-title">${t('more')}</h2>
      <button type="button" class="shell-close" aria-label="${t('close')}">${ICON.exit}</button>
    </header>
    <div class="shell-panel-body">
      ${onAdmin ? `
      <section class="shell-section">
        <h3 class="shell-section-title" data-label-key="nav">${t('nav')}</h3>
        <a class="shell-row" href="#mainscreen"><span class="shell-row-icon">${ICON.mainScreen}</span><span class="shell-row-label" data-label-key="mainScreen">${t('mainScreen')}</span></a>
        <a class="shell-row" href="#operator-roles"><span class="shell-row-icon">${ICON.roles}</span><span class="shell-row-label" data-label-key="roles">${t('roles')}</span></a>
        <a class="shell-row shell-admin-only" hidden href="#statistics"><span class="shell-row-icon">${ICON.stats}</span><span class="shell-row-label" data-label-key="stats">${t('stats')}</span></a>
        <a class="shell-row" href="#glossary"><span class="shell-row-icon">${ICON.glossary}</span><span class="shell-row-label" data-label-key="glossary">${t('glossary')}</span></a>
        <button type="button" class="shell-row shell-settings"><span class="shell-row-icon">${ICON.settings}</span><span class="shell-row-label" data-label-key="settings">${t('settings')}</span></button>
      </section>` : ''}
      <section class="shell-section" data-shell-prefs>
        <h3 class="shell-section-title" data-label-key="prefs">${t('prefs')}</h3>
        <div class="shell-setting">
          <span class="shell-setting-label" data-label-key="lang">${t('lang')}</span>
          <div class="choice-group shell-lang" role="group" aria-label="${t('lang')}">
            <button type="button" data-lang="ro">RO</button>
            <button type="button" data-lang="en">EN</button>
            <button type="button" data-lang="no">NO</button>
          </div>
        </div>
        <div class="shell-setting">
          <span class="shell-setting-label">${t('theme')}</span>
          <div class="choice-group shell-theme" role="group" aria-label="${t('theme')}">
            <button type="button" data-theme-choice="dark">${t('dark')}</button>
            <button type="button" data-theme-choice="light">${t('light')}</button>
            <button type="button" data-theme-choice="auto">${t('auto')}</button>
          </div>
        </div>
      </section>
      <section class="shell-section">
        <h3 class="shell-section-title">${t('screens')}</h3>
        <a class="shell-row" href="/translate"><span class="shell-row-icon">${ICON.projector}</span><span class="shell-row-label">${t('projector')}</span></a>
        <a class="shell-row" href="/remote"><span class="shell-row-icon">${ICON.remote}</span><span class="shell-row-label">${t('remote')}</span></a>
      </section>
      ${onAdmin ? '' : `
      <section class="shell-section shell-admin-only" hidden>
        <h3 class="shell-section-title">${t('adminTools')}</h3>
        <a class="shell-row" href="/admin#statistics"><span class="shell-row-icon">${ICON.stats}</span><span class="shell-row-label">${t('stats')}</span></a>
      </section>`}
      <section class="shell-section">
        <h3 class="shell-section-title">${t('account')}</h3>
        <a class="shell-row shell-team" href="/team" hidden><span class="shell-row-icon">${ICON.team}</span><span class="shell-row-label">${t('team')}</span></a>
        <button type="button" class="shell-row shell-logout"><span class="shell-row-icon">${ICON.logout}</span><span class="shell-row-label">${t('logout')}</span></button>
      </section>
    </div>`;
  body.append(backdrop, panel);

  // SV-TEAM-PAGE — show the Echipa link only for the owner account.
  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.user && d.user.role === 'owner') {
        const link = panel.querySelector('.shell-team');
        if (link) link.hidden = false;
        // SV-ADMIN-TABS-TRIM — owner-only Statistici / Text rapid shortcuts.
        panel.querySelectorAll('.shell-admin-only').forEach((el) => { el.hidden = false; });
      }
    })
    .catch(() => {});

  // --- sheet open / close ---
  let lastFocus = null;
  function openSheet() {
    lastFocus = document.activeElement;
    moreBtn.setAttribute('aria-expanded', 'true');
    backdrop.hidden = false;
    panel.hidden = false;
    void panel.offsetWidth;
    backdrop.classList.add('visible');
    panel.classList.add('visible');
    document.body.classList.add('shell-locked');
    panel.querySelector('.shell-close').focus();
  }
  function closeSheet() {
    moreBtn.setAttribute('aria-expanded', 'false');
    backdrop.classList.remove('visible');
    panel.classList.remove('visible');
    document.body.classList.remove('shell-locked');
    const done = () => {
      backdrop.hidden = true;
      panel.hidden = true;
    };
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done();
    else setTimeout(done, 200);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  moreBtn.addEventListener('click', () => (panel.hidden ? openSheet() : closeSheet()));
  backdrop.addEventListener('click', closeSheet);
  panel.querySelector('.shell-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closeSheet();
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('a[href]')) closeSheet();
  });

  // --- language switch ---
  function paintLang() {
    const cur = lang();
    panel.querySelectorAll('.shell-lang button').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.lang === cur ? 'true' : 'false');
    });
  }
  panel.querySelectorAll('.shell-lang button').forEach((b) => {
    b.addEventListener('click', () => {
      const l = b.dataset.lang;
      try {
        localStorage.setItem(LS_LANG, l);
      } catch {
        /* no storage */
      }
      if (window.adminI18n && typeof window.adminI18n.apply === 'function') window.adminI18n.apply(l);
      document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: l } }));
      relabel();
    });
  });

  // --- theme switch ---
  function paintTheme() {
    const cur = window.THEME ? window.THEME.pref : 'dark';
    panel.querySelectorAll('.shell-theme button').forEach((b) => {
      b.setAttribute('aria-pressed', b.dataset.themeChoice === cur ? 'true' : 'false');
    });
  }
  panel.querySelectorAll('.shell-theme button').forEach((b) => {
    b.addEventListener('click', () => {
      if (window.THEME) window.THEME.set(b.dataset.themeChoice);
      paintTheme();
    });
  });

  // --- logout (pre-accounts: clears the admin PIN session) ---
  panel.querySelector('.shell-logout').addEventListener('click', () => {
    fetch('/api/admin-logout', { method: 'POST' })
      .catch(() => {})
      .finally(() => {
        window.location.href = '/';
      });
  });

  // --- relabel on language change ---
  function relabel() {
    nav.querySelectorAll('.shell-item').forEach((el) => {
      const id = el.dataset.section;
      const label = el.querySelector('.shell-label');
      if (id && label) label.textContent = t(id);
    });
    const moreLabel = moreBtn.querySelector('.shell-label');
    if (moreLabel) moreLabel.textContent = t('more');
    panel.querySelector('.shell-panel-title').textContent = t('more');
    // Relabel the sheet's keyed rows/titles (the admin Navigare destinations, …).
    panel.querySelectorAll('[data-label-key]').forEach((el) => { el.textContent = t(el.dataset.labelKey); });
    paintLang();
  }
  document.addEventListener('i18n:change', () => {
    paintLang();
    relabel();
  });

  paintLang();
  paintTheme();

  // --- "Setări" opens the preferences block inside this sheet (no navigation) ---
  const settingsBtn = panel.querySelector('.shell-settings');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      const prefs = panel.querySelector('[data-shell-prefs]');
      if (prefs) prefs.scrollIntoView({ block: 'start', behavior: 'smooth' });
      const firstLang = prefs && prefs.querySelector('.shell-lang button');
      if (firstLang) firstLang.focus();
    });
  }

  // --- admin: mark the active bottom-bar entry from the current view ---
  // Views live behind #hashes handled by app.js (routeAdminHash); the shell only
  // reflects which one is active. Nav <a href="#…"> deep-links are activated by
  // that router on hashchange/load — no top tab bar needed.
  if (onAdmin) {
    let dashPref = 'home'; // whether the dashboard is currently "Acasă" or "Traducere"
    const setCurrent = (id) => {
      nav.querySelectorAll('.shell-item[data-section]').forEach((el) => {
        if (id && el.dataset.section === id) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      });
    };
    const markFromTab = (tab) => {
      if (tab === 'dashboard') setCurrent(dashPref);
      else if (tab === 'events') setCurrent('events');
      else if (tab === 'song') setCurrent('songs');
      else setCurrent(null); // mainscreen / operator-roles / statistics / transcript live in "Mai mult"
    };
    nav.querySelector('.shell-item[data-section="home"]')?.addEventListener('click', () => { dashPref = 'home'; });
    nav.querySelector('.shell-item[data-section="translate"]')?.addEventListener('click', () => { dashPref = 'translate'; });
    // Opening Cântări clears the pending-worship-request badge (the old top-tab
    // button did this; its handler now lives on the shell entry that carries the badge).
    nav.querySelector('.shell-item[data-section="songs"]')?.addEventListener('click', () => {
      if (typeof window.clearAdminSongTabBadge === 'function') window.clearAdminSongTabBadge();
    });
    document.addEventListener('admin:tab', (e) => markFromTab(e.detail && e.detail.tab));
  }
})();
