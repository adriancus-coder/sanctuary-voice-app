'use strict';

// SV-HOME-NOW — role-aware "Acum" home for signed-in users. One primary action
// per role, plus the live/next event card.
(function () {
  const $ = (id) => document.getElementById(id);

  const ROLE_CTA = {
    owner: { label: 'Deschide Admin', href: '/admin' },
    operator: { label: 'Traducere live', href: '/operator-dashboard' },
    presenter: { label: 'Worship', href: '/worship' },
    leader: { label: 'Worship', href: '/worship' },
    member: { label: 'Worship', href: '/worship' },
  };
  const ROLE_LABEL = {
    owner: 'Proprietar',
    operator: 'Operator',
    presenter: 'Prezentator',
    leader: 'Lider worship',
    member: 'Membru',
  };
  // Extra quick links per role (secondary surfaces).
  const ROLE_LINKS = {
    owner: [
      { label: 'Worship', href: '/worship' },
      { label: 'Ecran principal', href: '/translate' },
      { label: 'Echipa', href: '/team' },
    ],
    operator: [
      { label: 'Telecomandă', href: '/remote' },
      { label: 'Ecran principal', href: '/translate' },
    ],
    presenter: [{ label: 'Ecran principal', href: '/translate' }],
    leader: [{ label: 'Ecran principal', href: '/translate' }],
    member: [],
  };

  function renderLinks(role) {
    const wrap = $('homeLinks');
    wrap.innerHTML = '';
    (ROLE_LINKS[role] || []).forEach((l) => {
      const a = document.createElement('a');
      a.className = 'btn btn-secondary home-link';
      a.href = l.href;
      a.textContent = l.label;
      wrap.appendChild(a);
    });
  }

  function formatWhen(ev) {
    if (!ev || !ev.scheduledTimestamp) return '';
    try {
      return new Intl.DateTimeFormat([], {
        timeZone: ev.timezone || undefined,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ev.scheduledTimestamp));
    } catch {
      return new Date(ev.scheduledTimestamp).toLocaleString();
    }
  }

  function renderNow(health, upcoming) {
    const label = $('homeNowLabel');
    const title = $('homeNowTitle');
    const meta = $('homeNowMeta');
    const live = health && health.activeEvents > 0;
    const next = upcoming && upcoming.events && upcoming.events[0];
    if (live) {
      label.textContent = '🔴 Live acum';
      title.textContent = (health.organization && health.organization.name) || 'Serviciu live';
      meta.textContent = 'Un serviciu este în desfășurare.';
    } else if (next) {
      label.textContent = 'Următorul serviciu';
      title.textContent = next.name || 'Serviciu';
      meta.textContent = formatWhen(next);
    } else {
      label.textContent = 'Niciun serviciu programat';
      title.textContent = '';
      meta.textContent = 'Programul apare aici când un serviciu este creat.';
    }
  }

  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((me) => {
      if (!me || !me.user) {
        window.location.href = '/login';
        return;
      }
      const u = me.user;
      $('homeGreeting').textContent = 'Bună, ' + (u.name || '').split(' ')[0] + '!';
      $('homeRoleLine').textContent = ROLE_LABEL[u.role] || u.role;
      const cta = ROLE_CTA[u.role] || ROLE_CTA.member;
      const ctaEl = $('homeCta');
      ctaEl.textContent = cta.label;
      ctaEl.href = cta.href;
      renderLinks(u.role);
      return Promise.all([
        fetch('/api/health').then((r) => r.json()).catch(() => null),
        fetch('/api/events/upcoming').then((r) => r.json()).catch(() => null),
      ]).then(([health, upcoming]) => renderNow(health, upcoming));
    })
    .catch(() => {});
})();
