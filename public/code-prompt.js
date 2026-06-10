// Masked code prompt — shared by /admin (app.js) and /remote (remote.js).
// Replaces window.prompt() for admin/moderator codes and PINs: prompt()
// always echoes the typed text in clear, which leaks codes to anyone
// watching the screen or projector. This shows an in-page modal with an
// <input type="password"> instead.
//
// Usage: const code = await askForCode('Enter admin code or PIN:');
// Resolves with the trimmed value, or '' if the user cancels (same
// contract as (prompt(...) || '').trim()). Styling is applied via the
// CSSOM (el.style.*) so it works on every page regardless of which
// stylesheets are loaded, and is untouched by CSP.
(function () {
  let activeResolve = null;

  function buildModal() {
    const overlay = document.createElement('div');
    overlay.id = 'codePromptOverlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '99999',
      background: 'rgba(10, 14, 26, 0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#141a2e', color: '#f2f4fa',
      border: '1px solid rgba(212, 168, 83, 0.45)', borderRadius: '12px',
      padding: '22px', width: 'min(360px, calc(100vw - 32px))',
      boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
      font: '15px/1.45 system-ui, -apple-system, "Segoe UI", Arial, sans-serif'
    });

    const label = document.createElement('div');
    label.id = 'codePromptLabel';
    Object.assign(label.style, { marginBottom: '12px', fontWeight: '600' });

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    Object.assign(input.style, {
      width: '100%', boxSizing: 'border-box', padding: '10px 12px',
      borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.25)',
      background: '#0c101e', color: '#f2f4fa', fontSize: '16px', outline: 'none'
    });

    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px'
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, {
      padding: '9px 16px', borderRadius: '8px', cursor: 'pointer',
      border: '1px solid rgba(255, 255, 255, 0.25)', background: 'transparent', color: '#f2f4fa'
    });

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'OK';
    Object.assign(okBtn.style, {
      padding: '9px 16px', borderRadius: '8px', cursor: 'pointer',
      border: 'none', background: '#d4a853', color: '#141a2e', fontWeight: '700'
    });

    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(row);
    overlay.appendChild(box);

    function finish(value) {
      overlay.remove();
      const resolve = activeResolve;
      activeResolve = null;
      if (resolve) resolve(value);
    }

    okBtn.addEventListener('click', () => finish(input.value.trim()));
    cancelBtn.addEventListener('click', () => finish(''));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(''); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); finish(''); }
    });

    return { overlay, label, input };
  }

  window.askForCode = function askForCode(message) {
    return new Promise((resolve) => {
      // One prompt at a time — a second call cancels the pending one.
      if (activeResolve) {
        const prev = document.getElementById('codePromptOverlay');
        if (prev) prev.remove();
        const prevResolve = activeResolve;
        activeResolve = null;
        prevResolve('');
      }
      activeResolve = resolve;
      const { overlay, label, input } = buildModal();
      label.textContent = message || 'Enter code:';
      document.body.appendChild(overlay);
      input.focus();
    });
  };
})();
