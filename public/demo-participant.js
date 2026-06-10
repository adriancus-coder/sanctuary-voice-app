// Listener preview logic — extracted from the inline <script> in
// demo-participant.html (SEC-AUDIT-2026-06 B2) so the CSP can drop
// 'unsafe-inline' from scriptSrc. Depends on /demo-shared.js (window.SV_DEMO).
(function () {
  var select = document.getElementById('languageSelectDemo');
  var textEl = document.getElementById('demoMainText');
  var badgeEl = document.getElementById('demoLangBadge');

  function update(lang) {
    var verse = window.SV_DEMO.verses[lang] || window.SV_DEMO.verses.en;
    textEl.textContent = verse;
    textEl.dir = window.SV_DEMO.rtl[lang] ? 'rtl' : 'ltr';
    badgeEl.textContent = window.SV_DEMO.names[lang] || lang;
  }

  select.addEventListener('change', function () { update(select.value); });
  update(select.value);
})();
