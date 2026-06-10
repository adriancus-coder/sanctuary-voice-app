// Landing page logic — extracted from the inline <script> in landing.html
// (SEC-AUDIT-2026-06 B2) so the CSP can drop 'unsafe-inline' from scriptSrc.
// The two close/cancel buttons were onclick= attributes; wired below instead.

function closeOperatorModal() {
  var modal = document.getElementById('opModal');
  var form = document.getElementById('opLoginForm');
  var errorEl = document.getElementById('opLoginError');
  var pinInput = document.getElementById('opPin');
  var requestForm = document.getElementById('opRequestForm');
  var requestErr = document.getElementById('opRequestError');
  var loginView = document.getElementById('opLoginView');
  var requestView = document.getElementById('opRequestView');
  var waitingView = document.getElementById('opWaitingView');
  var deniedView = document.getElementById('opDeniedView');
  var waitingErr = document.getElementById('opWaitingError');

  if (window.__opStopPolling) try { window.__opStopPolling(); } catch (e) {}

  if (modal) modal.hidden = true;
  if (pinInput) pinInput.value = '';
  if (errorEl) errorEl.textContent = '';
  if (form) form.reset();
  if (requestForm) requestForm.reset();
  if (requestErr) requestErr.textContent = '';
  if (waitingErr) waitingErr.textContent = '';
  if (loginView) loginView.hidden = false;
  if (requestView) requestView.hidden = true;
  if (waitingView) waitingView.hidden = true;
  if (deniedView) deniedView.hidden = true;

  document.body.style.overflow = '';

  document.querySelectorAll('.op-modal-overlay').forEach(function (el) {
    if (el.id !== 'opModal') el.remove();
  });
}

(function () {
  var banner = document.getElementById('landingNextService');
  var textEl = document.getElementById('landingNextServiceText');
  if (!banner || !textEl) return;

  function formatScheduled(event) {
    if (!event || !event.scheduledTimestamp) return '';
    try {
      var fmt = new Intl.DateTimeFormat([], {
        timeZone: event.timezone || undefined,
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      return fmt.format(new Date(event.scheduledTimestamp));
    } catch (err) {
      return new Date(event.scheduledTimestamp).toLocaleString();
    }
  }

  fetch('/api/events/upcoming')
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data || !data.ok || !Array.isArray(data.events) || !data.events.length) return;
      var next = data.events[0];
      var label = formatScheduled(next);
      if (!label) return;
      textEl.textContent = (next.name ? next.name + ' · ' : '') + label;
      banner.hidden = false;
      banner.addEventListener('click', function () {
        setTimeout(function () {
          var input = document.getElementById('listenerEventId');
          if (input) input.focus();
        }, 320);
      });
    })
    .catch(function () {});
})();

(function () {
  var nav = document.getElementById('landingNav');
  var toggle = document.getElementById('landingNavToggle');
  var navLinks = document.getElementById('landingNavLinks');
  if (toggle && nav && navLinks) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    navLinks.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
})();

(function () {
  var btn = document.getElementById('operatorLoginBtn');
  var modal = document.getElementById('opModal');
  var form = document.getElementById('opLoginForm');
  var pinInput = document.getElementById('opPin');
  var errorEl = document.getElementById('opLoginError');

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    pinInput.focus();
  }

  btn.addEventListener('click', openModal);

  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeOperatorModal();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeOperatorModal();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = pinInput.value.trim();
    errorEl.textContent = '';
    if (!pin) {
      errorEl.textContent = 'Please enter your operator PIN.';
      return;
    }
    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting…';
    fetch('/api/operator-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin })
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok && data.operatorCode) {
          try {
            sessionStorage.setItem('operatorCode', data.operatorCode);
          } catch (err) {}
          window.location.href = '/operator-dashboard';
        } else {
          errorEl.textContent = data.error || 'Login failed. Please check your PIN and try again.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Connect';
        }
      })
      .catch(function () {
        errorEl.textContent = 'Connection error. Please try again.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Connect';
      });
  });

  var loginView = document.getElementById('opLoginView');
  var requestView = document.getElementById('opRequestView');
  var waitingView = document.getElementById('opWaitingView');
  var deniedView = document.getElementById('opDeniedView');
  var waitingMeta = document.getElementById('opWaitingMeta');
  var waitingErr = document.getElementById('opWaitingError');
  var showRequestBtn = document.getElementById('opShowRequestBtn');
  var requestBackBtn = document.getElementById('opRequestBackBtn');
  var waitingCancelBtn = document.getElementById('opWaitingCancelBtn');
  var deniedCloseBtn = document.getElementById('opDeniedCloseBtn');
  var requestForm = document.getElementById('opRequestForm');
  var reqName = document.getElementById('opReqName');
  var reqContact = document.getElementById('opReqContact');
  var reqError = document.getElementById('opRequestError');
  var reqSubmit = document.getElementById('opRequestSubmitBtn');

  var pollTimer = null;
  var pollFailures = 0;

  function showOnlyView(viewId) {
    [loginView, requestView, waitingView, deniedView].forEach(function (v) {
      if (v) v.hidden = (v.id !== viewId);
    });
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollFailures = 0;
  }
  window.__opStopPolling = stopPolling;

  function startPolling(requestId, pollToken) {
    stopPolling();
    if (waitingErr) waitingErr.textContent = '';
    pollTimer = setInterval(function () { pollOnce(requestId, pollToken); }, 4000);
    pollOnce(requestId, pollToken);
  }

  function pollOnce(requestId, pollToken) {
    fetch('/api/operator/request-status/' + encodeURIComponent(requestId) + '?token=' + encodeURIComponent(pollToken || ''))
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (resp) {
        var data = resp.data || {};
        if (!resp.ok || !data.ok) {
          pollFailures += 1;
          if (pollFailures >= 5 && waitingErr) waitingErr.textContent = 'Lost connection. Still trying…';
          return;
        }
        pollFailures = 0;
        if (data.status === 'granted' && data.operatorCode) {
          stopPolling();
          try { sessionStorage.setItem('operatorCode', data.operatorCode); } catch (e) {}
          window.location.href = data.redirectUrl || '/operator-dashboard';
          return;
        }
        if (data.status === 'denied') {
          stopPolling();
          showOnlyView('opDeniedView');
        }
      })
      .catch(function () {
        pollFailures += 1;
        if (pollFailures >= 5 && waitingErr) waitingErr.textContent = 'Lost connection. Still trying…';
      });
  }

  if (showRequestBtn && loginView && requestView) {
    showRequestBtn.addEventListener('click', function () {
      reqError.textContent = '';
      showOnlyView('opRequestView');
      if (reqName) reqName.focus();
    });
  }
  if (requestBackBtn) {
    requestBackBtn.addEventListener('click', function () {
      showOnlyView('opLoginView');
      pinInput.focus();
    });
  }
  if (waitingCancelBtn) {
    waitingCancelBtn.addEventListener('click', function () {
      stopPolling();
      closeOperatorModal();
    });
  }
  if (deniedCloseBtn) {
    deniedCloseBtn.addEventListener('click', function () {
      closeOperatorModal();
    });
  }
  if (requestForm) {
    requestForm.addEventListener('submit', function (e) {
      e.preventDefault();
      reqError.textContent = '';
      var name = (reqName.value || '').trim();
      var contact = (reqContact.value || '').trim();
      if (!name) { reqError.textContent = 'Please enter your name.'; return; }
      reqSubmit.disabled = true;
      reqSubmit.textContent = 'Sending…';
      fetch('/api/operator/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, contact: contact })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.ok && data.requestId) {
            requestForm.reset();
            if (waitingMeta) waitingMeta.textContent = 'Submitted as ' + name;
            showOnlyView('opWaitingView');
            startPolling(data.requestId, data.pollToken || '');
          } else {
            reqError.textContent = data.error || 'Could not send request. Try again.';
          }
        })
        .catch(function () { reqError.textContent = 'Connection error. Try again.'; })
        .finally(function () {
          reqSubmit.disabled = false;
          reqSubmit.textContent = 'Send request';
        });
    });
  }
})();

(function () {
  var form = document.getElementById('listenerJoinForm');
  var input = document.getElementById('listenerEventId');
  var err = document.getElementById('listenerJoinError');
  if (!form || !input) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    var raw = (input.value || '').trim();
    if (!raw) { err.textContent = 'Please enter the Event ID.'; return; }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Checking…';
    fetch('/api/events/resolve/' + encodeURIComponent(raw))
      .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, data: d }; }); })
      .then(function (resp) {
        var data = resp.data || {};
        if (!resp.ok || !data.ok || !data.eventId) {
          err.textContent = (data && data.error) || 'Event not found. Check the ID and try again.';
          btn.disabled = false; btn.textContent = label;
          return;
        }
        window.location.href = '/participant?event=' + encodeURIComponent(data.eventId);
      })
      .catch(function () {
        err.textContent = 'Connection error. Try again.';
        btn.disabled = false; btn.textContent = label;
      });
  });
})();

(function () {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('[data-animate]').forEach(function (el) { el.classList.add('is-visible'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('[data-animate]').forEach(function (el) { io.observe(el); });
})();

(function () {
  var closeBtn = document.getElementById('opModalClose');
  var cancelBtn = document.getElementById('opModalCancelBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeOperatorModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeOperatorModal);
})();
