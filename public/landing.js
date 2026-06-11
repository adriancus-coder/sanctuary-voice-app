'use strict';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── hero live-translation demo ── */
const SENTENCES = [
  { ro: 'Harul Domnului să fie cu voi cu toți.',
    en: 'The grace of the Lord be with you all.',
    no: 'Herrens nåde være med dere alle.' },
  { ro: 'Deschidem Scriptura la Matei, capitolul șase.',
    en: 'Open your Bibles to Matthew, chapter six.',
    no: 'Slå opp i Matteus, kapittel seks.' },
  { ro: 'Nu vă adunați comori pe pământ.',
    en: 'Do not store up treasures on earth.',
    no: 'Samle dere ikke skatter på jorden.' }
];
const srcLine = document.getElementById('srcLine');
const trEn = document.getElementById('trEn');
const trEnText = document.getElementById('trEnText');
const trNo = document.getElementById('trNo');
const trNoText = document.getElementById('trNoText');

async function playLoop() {
  if (!srcLine) return;
  if (reduced) {
    const s = SENTENCES[0];
    srcLine.textContent = s.ro; srcLine.classList.add('settled');
    trEnText.textContent = s.en; trNoText.textContent = s.no;
    trEn.classList.add('show'); trNo.classList.add('show');
    return;
  }
  let i = 0;
  for (;;) {
    const s = SENTENCES[i % SENTENCES.length];
    srcLine.classList.remove('settled');
    trEn.classList.remove('show'); trNo.classList.remove('show');
    const words = s.ro.split(' ');
    let cur = '';
    for (const w of words) {
      cur += (cur ? ' ' : '') + w;
      srcLine.innerHTML = cur + ' <span class="caret"></span>';
      await sleep(170 + Math.random() * 120);
    }
    await sleep(300);
    srcLine.textContent = s.ro;
    srcLine.classList.add('settled');
    await sleep(420);
    trEnText.textContent = s.en; trEn.classList.add('show');
    await sleep(260);
    trNoText.textContent = s.no; trNo.classList.add('show');
    await sleep(2600);
    i++;
  }
}
playLoop();

/* ── tilt 3D (telefon + carduri) ── */
function addTilt(el, max) {
  if (reduced || !matchMedia('(hover:hover)').matches || !el) return;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = 'rotateY(' + (x * max).toFixed(2) + 'deg) rotateX(' + (-y * max).toFixed(2) + 'deg)';
    const glare = el.querySelector('.glare');
    if (glare) {
      glare.style.background = 'linear-gradient(' + (118 + x * 40) + 'deg, rgba(255,255,255,' +
        (0.11 + y * -0.04) + ') 0%, rgba(255,255,255,.02) 30%, transparent 48%)';
    }
  });
  el.addEventListener('pointerleave', () => { el.style.transform = ''; });
}
addTilt(document.getElementById('phone'), 8);
document.querySelectorAll('.fcard').forEach((c) => addTilt(c, 4));
addTilt(document.querySelector('.churches .card'), 4);

/* ── praf în razele de lumină (canvas) ── */
(function dustFx() {
  const cv = document.getElementById('fx');
  if (reduced || !cv) return;
  const hero = cv.parentElement;
  const ctx = cv.getContext('2d');
  let W, H, parts = [];
  function size() {
    W = cv.width = hero.offsetWidth;
    H = cv.height = hero.offsetHeight;
    parts = [];
    const N = Math.min(46, Math.floor(W / 26));
    for (let i = 0; i < N; i++) {
      parts.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.6 + Math.random() * 1.7,
        vx: -0.06 - Math.random() * 0.1, vy: -0.12 - Math.random() * 0.16,
        a: Math.random() * Math.PI * 2,
        warm: Math.random() > 0.45
      });
    }
  }
  size();
  addEventListener('resize', size);
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.a += 0.015;
      if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; }
      if (p.x < -6) p.x = W + 6;
      const tw = 0.25 + (Math.sin(p.a) + 1) * 0.26;
      ctx.beginPath();
      ctx.fillStyle = p.warm ? 'rgba(228,176,74,' + (tw * 0.5) + ')' : 'rgba(214,222,236,' + (tw * 0.32) + ')';
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
})();

/* ── moduri de traducere ── */
const MODES = {
  rapid: { out: 'And I want you to understand, dear ones, that our attitude toward material values reveals us most honestly.',
           desc: 'Minimal latency, short phrases. For fast conversation and Q&A.' },
  balanced: { out: 'And I want you to understand, dear ones, that our attitude toward material values reveals us most honestly.',
              desc: 'Speed and context in balance. Recommended for most services.' },
  clear: { out: 'And I want you to understand, my dear ones, that our attitude toward material values is what reveals us most honestly.',
           desc: 'More context per sentence, quality translation. For measured speakers.' },
  interpret: { out: 'Our attitude toward material things reveals us most honestly.',
               desc: 'Paraphrases concisely, like a human interpreter — so the room keeps pace with a fast or continuous speaker.' }
};
const modeOut = document.getElementById('modeOut');
const modeDesc = document.getElementById('modeDesc');
document.querySelectorAll('.chip').forEach((ch) => {
  ch.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => { c.classList.remove('on'); c.setAttribute('aria-selected', 'false'); });
    ch.classList.add('on'); ch.setAttribute('aria-selected', 'true');
    const m = MODES[ch.dataset.mode];
    if (m) { modeOut.textContent = m.out; modeDesc.textContent = m.desc; }
  });
});

/* ── join by code ──
   RECON-WIRE: fluxul REAL de join (preluat din vechiul landing): codul tastat NU merge
   direct în URL — se rezolvă întâi prin GET /api/events/resolve/:value (acceptă ID complet
   sau shortId, normalizat server-side), apoi navigăm la /participant?event=<eventId rezolvat>. */
const joinForm = document.getElementById('joinForm');
const joinCode = document.getElementById('joinCode');
let joinErrEl = null;
function showJoinError(msg) {
  if (!joinForm) return;
  if (!joinErrEl) {
    joinErrEl = document.createElement('p');
    joinErrEl.className = 'join-note';
    joinErrEl.setAttribute('role', 'alert');
    joinForm.insertAdjacentElement('afterend', joinErrEl);
  }
  joinErrEl.textContent = msg;
}
if (joinForm) {
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = (joinCode.value || '').trim();
    if (!code) { joinCode.focus(); return; }
    showJoinError('');
    const btn = joinForm.querySelector('button[type="submit"]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    fetch('/api/events/resolve/' + encodeURIComponent(code))
      .then((res) => res.json().then((d) => ({ ok: res.ok, data: d })))
      .then((resp) => {
        const data = resp.data || {};
        if (!resp.ok || !data.ok || !data.eventId) {
          showJoinError((data && data.error) || 'Event not found. Check the code and try again.');
          btn.disabled = false; btn.textContent = label;
          return;
        }
        location.href = '/participant?event=' + encodeURIComponent(data.eventId);
      })
      .catch(() => {
        showJoinError('Connection error. Try again.');
        btn.disabled = false; btn.textContent = label;
      });
  });
}

/* ── next service (PRESERVED) ──
   Mutat VERBATIM din vechiul public/landing.js (fetch /api/events/upcoming + populare
   #landingNextService). Singura adaptare: focusul de pe click țintește noul input
   #joinCode (vechiul id #listenerEventId nu mai există în markup). */
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
          var input = document.getElementById('joinCode');
          if (input) input.focus();
        }, 320);
      });
    })
    .catch(function () {});
})();

/* ── scroll reveals ── */
if (!reduced && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((es) => es.forEach((en) => {
    if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }), { threshold: 0.12 });
  document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
} else {
  document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('in'));
}
