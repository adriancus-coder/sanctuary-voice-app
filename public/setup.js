'use strict';

// SV-ACCOUNTS-SETUP — first-owner creation page logic.
(function () {
  const form = document.getElementById('setupForm');
  const errorEl = document.getElementById('setupError');
  const submit = document.getElementById('setupSubmit');

  const MESSAGES = {
    setupBadToken: 'Token de configurare greșit (folosește PIN-ul de admin).',
    setupDisabled: 'Configurarea este dezactivată (lipsește PIN-ul de admin pe server).',
    setupDone: 'Configurarea a fost deja făcută.',
    emailExists: 'Există deja un cont cu acest email.',
    badEmail: 'Email invalid.',
    badName: 'Numele este obligatoriu.',
    weakPassword: 'Parola trebuie să aibă cel puțin 10 caractere.',
    network: 'Eroare de conexiune. Încearcă din nou.',
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const password = document.getElementById('password').value;
    if (password.length < 10) {
      errorEl.textContent = MESSAGES.weakPassword;
      return;
    }
    submit.disabled = true;
    fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        churchName: document.getElementById('churchName').value,
        ownerName: document.getElementById('ownerName').value,
        email: document.getElementById('email').value,
        password,
        setupToken: document.getElementById('setupToken').value,
      }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
      .then((resp) => {
        if (resp.ok && resp.data.ok) {
          window.location.href = '/';
          return;
        }
        errorEl.textContent = MESSAGES[resp.data.code] || 'Configurarea a eșuat.';
        submit.disabled = false;
      })
      .catch(() => {
        errorEl.textContent = MESSAGES.network;
        submit.disabled = false;
      });
  });
})();
