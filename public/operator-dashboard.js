(function () {
  var LANG_NAMES = {
    ro: 'Romanian',
    no: 'Norwegian',
    ru: 'Russian',
    uk: 'Ukrainian',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    pl: 'Polish',
    tr: 'Turkish',
    ar: 'Arabic',
    fa: 'Persian',
    hu: 'Hungarian',
    el: 'Greek'
  };

  var operatorCode = '';
  try {
    operatorCode = sessionStorage.getItem('operatorCode') || '';
  } catch (err) {
    operatorCode = '';
  }

  var statusEl = document.getElementById('opDashStatus');
  var listEl = document.getElementById('opEventsList');
  var template = document.getElementById('opEventCardTemplate');
  var logoutBtn = document.getElementById('opLogoutBtn');

  if (!operatorCode) {
    redirectToLogin();
    return;
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      clearSessionAndGoHome();
    });
  }

  loadEvents();

  function redirectToLogin() {
    try { sessionStorage.removeItem('operatorCode'); } catch (err) {}
    window.location.href = '/';
  }

  function clearSessionAndGoHome() {
    try { sessionStorage.removeItem('operatorCode'); } catch (err) {}
    window.location.href = '/';
  }

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-error', !!isError);
  }

  function formatDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatLang(code) {
    var key = String(code || '').toLowerCase();
    return LANG_NAMES[key] || (code ? String(code).toUpperCase() : '—');
  }

  var STATUS_LABEL = {
    active: 'Live now',
    scheduled: 'Scheduled',
    unscheduled: 'Draft',
    past: 'Ended'
  };

  function loadEvents() {
    setStatus('Loading events…', false);
    fetch('/api/operator/events', {
      method: 'GET',
      headers: { 'X-Operator-Code': operatorCode }
    })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          redirectToLogin();
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (!data.ok) {
          setStatus(data.error || 'Could not load events.', true);
          return;
        }
        renderEvents(data.events || []);
      })
      .catch(function () {
        setStatus('Connection error. Please try again.', true);
      });
  }

  function renderEvents(events) {
    listEl.innerHTML = '';
    if (!events.length) {
      setStatus('No events yet. Ask the admin to create one.', false);
      return;
    }
    setStatus('', false);
    events.forEach(function (event) { listEl.appendChild(buildCard(event)); });
  }

  function buildCard(event) {
    var node = template.content.firstElementChild.cloneNode(true);
    var status = event.status || (event.isActive ? 'active' : 'past');

    node.classList.add('operator-event-card-' + status);
    node.querySelector('.operator-event-name').textContent = event.name || 'Untitled event';
    node.querySelector('.operator-event-date').textContent = formatDate(event.date);
    node.querySelector('.operator-event-lang').textContent = formatLang(event.sourceLang);

    var statusEl = node.querySelector('.operator-event-status');
    if (statusEl) {
      statusEl.textContent = STATUS_LABEL[status] || 'Event';
      statusEl.dataset.status = status;
    }

    var form = node.querySelector('.operator-event-form');
    var input = node.querySelector('.operator-event-input');
    var errorEl = node.querySelector('.operator-event-error');
    var submitBtn = node.querySelector('.operator-event-join');

    if (status !== 'active') {
      var note = document.createElement('div');
      note.className = 'operator-event-note';
      if (status === 'scheduled') note.textContent = 'Available to join when the service goes live.';
      else if (status === 'past') note.textContent = 'This service has ended.';
      else note.textContent = 'Not scheduled yet.';
      form.replaceWith(note);
      return node;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errorEl.textContent = '';
      var rawEntry = input.value.trim();
      if (!rawEntry) {
        errorEl.textContent = 'Invalid Event ID';
        return;
      }
      var normalizedEntry = rawEntry.toUpperCase().replace(/[^A-Z0-9]/g, '');
      var normalizedShort = String(event.shortId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      var matches = normalizedShort && normalizedEntry === normalizedShort;
      if (!matches && rawEntry !== event.id) {
        errorEl.textContent = 'Invalid Event ID';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Joining…';
      fetch('/api/operator/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: matches ? normalizedShort : rawEntry, operatorCode: operatorCode })
      })
        .then(function (res) {
          if (res.status === 401) {
            redirectToLogin();
            return null;
          }
          return res.json();
        })
        .then(function (data) {
          if (!data) return;
          if (data.ok && data.redirectUrl) {
            window.location.href = data.redirectUrl;
            return;
          }
          errorEl.textContent = data.error || 'Invalid Event ID';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Join';
        })
        .catch(function () {
          errorEl.textContent = 'Connection error. Please try again.';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Join';
        });
    });

    return node;
  }
})();
