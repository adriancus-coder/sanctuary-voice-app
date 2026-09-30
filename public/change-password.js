'use strict';

// SV-ACCOUNTS-STORE — password change page logic.
(function () {
  const form = document.getElementById('pwForm');
  const current = document.getElementById('pwCurrent');
  const next = document.getElementById('pwNew');
  const confirm = document.getElementById('pwConfirm');
  const errorEl = document.getElementById('pwError');
  const submit = document.getElementById('pwSubmit');
  const intro = document.getElementById('pwIntro');

  const MESSAGES = {
    wrongPassword: 'Parola actuală este greșită.',
    tooShort: 'Parola nouă trebuie să aibă cel puțin 10 caractere.',
    samePassword: 'Parola nouă trebuie să fie diferită de cea actuală.',
    tooManyAttempts: 'Prea multe încercări. Așteaptă câteva minute.',
    mismatch: 'Parolele nu se potrivesc.',
    network: 'Eroare de conexiune. Încearcă din nou.',
  };

  // If the account is flagged must-change-password, say so.
  fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && data.user && data.user.mustChangePassword) {
        intro.textContent = 'Trebuie să îți schimbi parola înainte de a continua.';
      }
    })
    .catch(() => {});

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    if (next.value.length < 10) {
      errorEl.textContent = MESSAGES.tooShort;
      return;
    }
    if (next.value !== confirm.value) {
      errorEl.textContent = MESSAGES.mismatch;
      return;
    }
    submit.disabled = true;
    fetch('/api/me/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: current.value, password: next.value }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, data: d })))
      .then((resp) => {
        if (resp.ok && resp.data.ok) {
          window.location.href = '/';
          return;
        }
        errorEl.textContent = MESSAGES[resp.data.code] || 'Nu am putut schimba parola.';
        submit.disabled = false;
      })
      .catch(() => {
        errorEl.textContent = MESSAGES.network;
        submit.disabled = false;
      });
  });
})();
