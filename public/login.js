'use strict';

// SV-ACCOUNTS-GUARDS — account login. Posts to /api/auth/login and redirects to
// ?next (sanitised to a local path) or /.
(function () {
  const form = document.getElementById('loginForm');
  const email = document.getElementById('loginEmail');
  const password = document.getElementById('loginPassword');
  const remember = document.getElementById('loginRemember');
  const errorEl = document.getElementById('loginError');
  const submit = document.getElementById('loginSubmit');

  const MESSAGES = {
    invalidLogin: 'Email sau parolă greșită.',
    tooManyAttempts: 'Prea multe încercări. Așteaptă câteva minute.',
    network: 'Eroare de conexiune. Încearcă din nou.',
  };

  function safeNext() {
    try {
      const n = new URLSearchParams(window.location.search).get('next') || '/';
      if (n.startsWith('/') && !n.startsWith('//')) return n;
    } catch {
      /* ignore */
    }
    return '/';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    if (!email.value.trim() || !password.value) return;
    submit.disabled = true;
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.value.trim(),
        password: password.value,
        remember: !!remember.checked,
      }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, data: d })))
      .then((resp) => {
        if (resp.ok && resp.data.ok) {
          window.location.href = safeNext();
          return;
        }
        errorEl.textContent = MESSAGES[resp.data.code] || 'Autentificare eșuată.';
        submit.disabled = false;
      })
      .catch(() => {
        errorEl.textContent = MESSAGES.network;
        submit.disabled = false;
      });
  });
})();
