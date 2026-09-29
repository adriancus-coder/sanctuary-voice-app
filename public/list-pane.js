'use strict';

// SV-LIST-PANES — a long list scrolls inside its own pane instead of growing
// the page. Mark a scroll container with data-list-pane="<label>"; this script
// adds the .list-pane class (CSS gives it a bounded height + internal scroll)
// and makes it a keyboard-focusable region only while it actually overflows,
// so it stays out of the tab order when short.
(function () {
  const panes = [];

  function update(pane) {
    const overflow = pane.scrollHeight > pane.clientHeight + 1 && !pane.hidden && pane.offsetParent !== null;
    if (overflow) {
      pane.tabIndex = 0;
      pane.setAttribute('role', 'region');
      const label = pane.getAttribute('data-list-pane');
      if (label) pane.setAttribute('aria-label', label);
    } else {
      pane.removeAttribute('tabindex');
      pane.removeAttribute('role');
      pane.removeAttribute('aria-label');
    }
  }

  function attach(pane) {
    if (panes.includes(pane)) return;
    panes.push(pane);
    pane.classList.add('list-pane');
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update(pane);
      });
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(pane);
    new MutationObserver(schedule).observe(pane, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    });
    window.addEventListener('resize', schedule);
    update(pane);
  }

  function attachAll(root) {
    (root || document).querySelectorAll('[data-list-pane]').forEach(attach);
  }

  window.LIST_PANE = { attach, attachAll, update: () => panes.forEach(update) };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => attachAll());
  } else {
    attachAll();
  }
})();
