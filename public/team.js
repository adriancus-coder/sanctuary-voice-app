'use strict';

// SV-TEAM-PAGE — the owner creates and manages team accounts.
(function () {
  const $ = (id) => document.getElementById(id);
  const listEl = $('teamList');
  const statusEl = $('teamStatus');
  const addForm = $('teamAddForm');
  const addErr = $('teamAddError');
  const addBtn = $('teamAddBtn');
  const tempCard = $('teamTempCard');
  const tempText = $('teamTempText');

  const ROLE_LABELS = {
    owner: 'Proprietar',
    operator: 'Operator',
    presenter: 'Prezentator',
    leader: 'Lider worship',
    member: 'Membru',
  };
  const TEAM_ROLES = ['operator', 'presenter', 'leader', 'member'];
  const ERR = {
    emailExists: 'Există deja un cont cu acest email.',
    badEmail: 'Email invalid.',
    badName: 'Numele este obligatoriu.',
    badRole: 'Rol invalid.',
    forbidden: 'Doar proprietarul poate gestiona echipa.',
    teamNotOwnerOrSelf: 'Nu poți modifica proprietarul sau propriul cont.',
    teamUserNotFound: 'Cont inexistent.',
    network: 'Eroare de conexiune.',
  };

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }
  function api(url, opts) {
    return fetch(url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)).then((r) => {
      if (r.status === 401 || r.status === 403) {
        window.location.href = '/login?next=/team';
        throw new Error('auth');
      }
      return r.json().then((d) => ({ ok: r.ok, status: r.status, data: d }));
    });
  }

  function pill(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function statusPill(u) {
    if (u.active === false) return pill('status-pill status-inactive', 'Dezactivat');
    if (u.mustChangePassword) return pill('status-pill status-mustchange', 'Parolă temporară');
    return pill('status-pill status-active', 'Activ');
  }

  function render(users) {
    listEl.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'history-item team-row';
      const head = document.createElement('div');
      head.className = 'team-row-head';
      const name = document.createElement('strong');
      name.textContent = u.name;
      const email = document.createElement('span');
      email.className = 'muted small';
      email.textContent = u.email;
      head.append(name, pill('role-pill role-' + u.role, ROLE_LABELS[u.role] || u.role), statusPill(u));
      row.append(head, email);

      if (u.role !== 'owner') {
        const actions = document.createElement('div');
        actions.className = 'team-row-actions';

        const roleSel = document.createElement('select');
        roleSel.className = 'team-role-select';
        TEAM_ROLES.forEach((r) => {
          const o = document.createElement('option');
          o.value = r;
          o.textContent = ROLE_LABELS[r];
          if (r === u.role) o.selected = true;
          roleSel.appendChild(o);
        });
        roleSel.addEventListener('change', () => {
          api('/api/team/' + u.id, { method: 'PATCH', body: JSON.stringify({ role: roleSel.value }) })
            .then((resp) => {
              if (!resp.ok) setStatus(ERR[resp.data.code] || 'Eroare.');
              load();
            })
            .catch(() => {});
        });
        actions.appendChild(roleSel);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'btn btn-dark btn-sm';
        resetBtn.textContent = 'Resetează parola';
        resetBtn.addEventListener('click', () => {
          api('/api/team/' + u.id + '/reset-password', { method: 'POST' })
            .then((resp) => {
              if (resp.ok && resp.data.ok) showTemp(u.email, resp.data.temporaryPassword);
              else setStatus(ERR[resp.data.code] || 'Eroare.');
            })
            .catch(() => {});
        });
        actions.appendChild(resetBtn);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = u.active === false ? 'btn btn-dark btn-sm' : 'delete-link';
        toggle.textContent = u.active === false ? 'Reactivează' : 'Dezactivează';
        toggle.addEventListener('click', () => {
          const action = u.active === false ? 'reactivate' : 'deactivate';
          api('/api/team/' + u.id + '/' + action, { method: 'POST' })
            .then((resp) => {
              if (!resp.ok) setStatus(ERR[resp.data.code] || 'Eroare.');
              load();
            })
            .catch(() => {});
        });
        actions.appendChild(toggle);

        row.appendChild(actions);
      }
      listEl.appendChild(row);
    });
    if (window.LIST_PANE) window.LIST_PANE.update();
  }

  function showTemp(email, temp) {
    tempText.textContent = 'Email: ' + email + '\nParolă temporară: ' + temp + '\n\nIntră pe /login și schimbă parola la prima autentificare.';
    tempCard.classList.remove('hidden');
    tempCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function load() {
    setStatus('Se încarcă…');
    api('/api/team', {})
      .then((resp) => {
        if (resp.ok && resp.data.ok) {
          setStatus('');
          render(resp.data.users);
        } else {
          setStatus(ERR[resp.data.code] || 'Nu am putut încărca echipa.');
        }
      })
      .catch(() => {});
  }

  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    addErr.textContent = '';
    const body = {
      name: $('taName').value.trim(),
      email: $('taEmail').value.trim(),
      role: $('taRole').value,
    };
    if (!body.name || !body.email) return;
    addBtn.disabled = true;
    api('/api/team', { method: 'POST', body: JSON.stringify(body) })
      .then((resp) => {
        if (resp.ok && resp.data.ok) {
          showTemp(resp.data.user.email, resp.data.temporaryPassword);
          addForm.reset();
          load();
        } else {
          addErr.textContent = ERR[resp.data.code] || 'Nu am putut crea contul.';
        }
        addBtn.disabled = false;
      })
      .catch(() => {
        addBtn.disabled = false;
      });
  });

  $('teamTempCopy').addEventListener('click', () => {
    try {
      navigator.clipboard.writeText(tempText.textContent);
    } catch {
      /* ignore */
    }
  });

  load();
})();
