// Main-screen preview logic — extracted from the inline <script> in
// demo-screen.html (SEC-AUDIT-2026-06 B2) so the CSP can drop
// 'unsafe-inline' from scriptSrc. Depends on /demo-shared.js (window.SV_DEMO).
(function () {
  var select = document.getElementById('demoScreenLang');
  var textEl = document.getElementById('demoScreenText');
  var fsBtn = document.getElementById('demoFullscreenBtn');

  select.value = 'en';

  function updateText(lang) {
    var verse = window.SV_DEMO.verses[lang] || window.SV_DEMO.verses.en;
    textEl.textContent = verse;
    textEl.dir = window.SV_DEMO.rtl[lang] ? 'rtl' : 'ltr';
  }

  select.addEventListener('change', function () { updateText(select.value); });
  updateText(select.value);

  function syncFullscreenBtn() {
    fsBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  }

  fsBtn.addEventListener('click', function () {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
  });

  document.addEventListener('fullscreenchange', syncFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', syncFullscreenBtn);
  syncFullscreenBtn();
})();
