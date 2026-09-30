# Navigation — in-page tabs & sticky action bars

The operator pages used to be long single columns. They are now **task-oriented
in-page tabs** with a **sticky action bar** for each page's primary buttons.

## The rule

> On every page, what you act on **during the service** is visible without
> scrolling on a phone (375×812) and a tablet (1024×768); everything else is one
> tap away in a tab or a sheet.

This is a layout rule only. Tabs never change socket messages, `/mode` /
`/display/mode` semantics, the projector page, the spectator surfaces, or the
participant flow. When you split a page, assert an id/label inventory **before vs
after** so no control goes missing.

## `page-tabs.js` — the shared component

A sticky segmented tab bar rendered under a page header, plus a sticky-action-bar
helper. Declarative via data attributes.

```html
<nav class="page-tabs" data-page-tabs="dashTabs"
     data-tabs='[{"id":"live","label":"Live","i18n":"dtab.live"},
                 {"id":"receptie","label":"Recepție","i18n":"dtab.receptie"}]'></nav>

<!-- a tab groups one or more existing sections, tagged in place: -->
<section data-tab-for="dashTabs" data-tab="live"> … </section>
<section data-tab-for="dashTabs" data-tab="receptie"> … </section>
```

- **Selection** follows the UI rules: `aria-selected`, accent fill + check mark +
  bold on the active tab, 44px targets.
- **State**: the active tab is written to the URL hash (`#dashTabs=live`) and
  remembered per bar per device (`localStorage['sv-tabs:<barId>']`); reload
  restores it. `hashchange` is honoured.
- **Keyboard**: ←/→ move between tabs, Home/End jump to first/last.
- **Badges**: `PageTabs.setBadge(barId, tabId, text)` (e.g. an online count);
  falsy/`0` hides it.
- **i18n**: put `data-i18n` on the tab (the component does) so `admin-i18n.js` and
  `i18n.js` both translate it; labels are resolved on build and re-applied on
  `i18n:change`.
- **API**: `window.PageTabs = { init, activate, setBadge, updateStickyOffsets }`.
  It auto-inits on `DOMContentLoaded`; call `init(root)` again after injecting new
  bars.

### Sticky action bar

```html
<div class="sticky-actions" data-sticky-actions data-tab-for="dashTabs" data-tab="live">
  <button id="startRecognitionBtn" …>Start</button>
  <button id="stopRecognitionBtn" …>Stop</button>
  …
</div>
```

- Pinned above the app bar on phones/tablets, in the content column at ≥1024px.
- Wraps two-per-row below 1024px so long labels never overflow; 44px targets.
- The component measures the visible bar into `--sticky-actions-h`, and the page
  keeps `padding-bottom` for it, so the bar never covers content.
- Prefer **moving** the page's real primary buttons into the bar (a DOM move keeps
  their handlers). When a button lives in a panel you don't want to move, add a
  proxy button with `data-proxy-click="<id>"` and a one-line document listener that
  clicks the original — no handler duplicated.

## Two integration shapes

1. **No per-panel gating (admin dashboard, /remote):** tag the sections (or wrap a
   group in a container) with `data-tab-for`/`data-tab` and let page-tabs show/hide
   them. `/remote` wraps its permission-gated panels in tab **containers** so
   page-tabs toggles the container while `remote.js` keeps its `main_screen` / `song`
   gating on the inner panels — two mechanisms never touch the same element.
2. **Role-gated switch with side effects (/worship):** the page keeps its own
   `toggleMode()` as the authority (role gating + live-mode side effects) and is
   only **restyled** as a sticky segmented bar; it also writes the hash and
   remembers the tab per device, restored on reload on every entry path. This
   avoids a second mechanism fighting the gating.

## Where it's used

| Page | Tabs | Sticky action bar |
|---|---|---|
| Admin dashboard | Live · Recepție · Transcript · Sistem | Live: Start · Stop · End · Ecran negru |
| `/worship` | Program · Live · Roluri | Live: previous · next · repeat chorus · fullscreen |
| `/remote` | Ecran · Cântări | Ecran: Ecran negru · Anulează · Text fixat |

Verify each with Playwright at 375×812 and 1024×768 (and 1180×820), RO/EN/NO,
dark/light: primary live controls + current content inside the viewport without
scrolling; tabs switch without reload; hash restored on reload; sticky bar never
covers content; no control missing (id/label inventory before vs after).
