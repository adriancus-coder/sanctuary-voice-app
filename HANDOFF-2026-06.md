# Handoff — Sesiune audit & hardening (2026-06-10)

Document pentru o sesiune Claude viitoare (sau pentru autor). Rezumă tot ce s-a
făcut pornind de la auditul `AUDIT-2026-06.md`. Toate modificările sunt **pe
branch-ul `dev`** (fluxul cerut: dezvoltare pe feature-branch → PR draft → merge
în `dev` pentru testare → autorul promovează `dev` → `main`).

## Stare la zi

- **Branch de integrare:** `dev` (12 commit-uri înaintea lui `main`, din care 4 commit-uri + 3 merge-uri sunt din această sesiune).
- **`main`:** neatins — nimic din sesiune nu e încă pe `main`. Promovarea o face autorul după testele pe `dev`.
- **`npm audit`:** 0 vulnerabilități.
- **Smoke test:** `npm run smoke` → 13/13.

## Ce s-a livrat (toate merge-uite în `dev`)

| PR | Commit | Conținut |
|----|--------|----------|
| #9 | `86bdb47`, `bed39bb` | Raportul de audit + fix-uri securitate A1, A2, B1, D |
| #10 | `527d730` | Smoke test fluxul de acces operator (`npm run smoke`) |
| #11 | `ad64204` | Infra hardening C1-C4 |

### Securitate (PR #9)

- **A1 — scurgere cod de operator (High):** `access_request_created` se emite acum
  doar către camera globală `admins` (în care adminii intră la `join_event`),
  nu prin `io.emit` către toți clienții. `GET /api/operator/request-status/:id`
  cere un `pollToken` secret per cerere, returnat doar solicitantului la creare,
  comparat timing-safe; răspuns 404 identic la mismatch (fără oracle de existență).
  Atins: `server.js` (request-access + request-status), `socket/handlers.js`
  (camera `admins`), `public/landing.html` (trimite token-ul la polling).
- **A2 — comparații timing-safe (High):** `safeStringEqual()` în
  `resolveEventAccessFromCode`, `isOperatorPinValid`, `canManageEvents` și pe
  header-ul `x-main-operator-code` (`/admin/audit-translations`,
  `/admin/normalize-content`). Bonus: un cod gol nu mai poate egala un `adminCode` gol.
- **B1 — coduri admin pe client (High):** mutate din `localStorage` în
  `sessionStorage` (`public/app.js`), cu sweep one-time al cheilor vechi
  `sanctuary_admin_code_*`.
- **D — dependențe:** `npm audit fix` (qs DoS, ws memory disclosure) + Azure
  Speech SDK 1.49→1.50 + override `uuid@^11.1.1` în `package.json` (SDK-ul
  folosește doar `uuid.v4()`, verificat funcțional).

### Smoke test (PR #10)

`scripts/smoke-operator-access.js`, expus ca `npm run smoke`. Self-contained:
pornește `server.js` pe port de test cu `DATA_DIR` temporar + PIN de admin
cunoscut (NU atinge datele reale), rulează 13 aserțiuni pe fluxul de acces
operator (token gating A1, login admin A2, grant/deny, authz 401), curăță după
el. Fără dependențe externe (Node 18+ `fetch`). Exit 0/1 — gata pentru CI.

### Infra hardening (PR #11)

- **C1 — scrieri atomice:** helper `atomicWriteFileSync` (tmp+fsync+rename)
  extras în `lib/db.js`, refolosit în save DB + flush cache traduceri + backup audit.
- **C2 — arhive audio orfane:** `DELETE /api/events/:id` șterge arhiva `.webm`
  a evenimentului (best-effort).
- **C3 — logging rejections:** `unhandledRejection`/`uncaughtException` ajung și
  în `app.log` via `logger.error`, pasând **string-ul** (nu obiectul Error),
  ca să nu se atingă `.stack` — contractul V22.37 e păstrat.
- **C4 — operațional:** `NODE_ENV=production` în `render.yaml`; sweep
  `transcribeRateLimits` mai devreme (200 vs 500).

## Rămas de făcut

- **B2 — CSP `'unsafe-inline'` în `scriptSrc` (Medium-High), NEÎNCEPUT.** Singurul
  punct rămas din audit. E mai riscant: cere inventarul tuturor scripturilor
  inline / handler-elor `onclick` din paginile HTML (ex. `landing.html`) și fie
  externalizarea lor, fie nonce-uri generate server-side per request. Dacă se
  scapă ceva, CSP-ul blochează silențios scriptul → pagina se rupe, deci necesită
  **verificare vizuală pe fiecare pagină** (`/admin`, `/translate`, `/participant`,
  `/remote`, landing). Pasul următor recomandat: întâi un inventar, apoi decizie
  externalizare vs nonce, apoi cod, într-un PR separat.

## Teste manuale recomandate pe `dev` (nu pot fi automatizate ușor)

1. **Flux acces operator end-to-end în browser:** cerere acces → notificare la
   admin (lista de cereri se actualizează fără refresh — depinde de noua cameră
   `admins`) → aprobare → redirect automat al operatorului. *Punct sensibil:
   confirmă că adminul deja conectat vede cererea nouă.*
2. **Persistența codului admin (B1):** F5 păstrează sesiunea în același tab;
   închiderea tab-ului cere re-introducerea codului (comportament nou intenționat).
3. **Azure Speech (D):** dacă se folosește `SPEECH_PROVIDER=azure_sdk`, o probă
   live scurtă (start/chunk/stop) după upgrade-ul SDK 1.50 + uuid 11.

## Alternative de pipeline (din `AUDIT-2026-06.md`, secțiunea F)

Pe scurt: **păstrați traducerea GPT-4.1-nano cu streaming** (cea mai ieftină +
singura cu glosar liber). Câștigul mare e STT pe WebSocket streaming în loc de
chunk-uri (3-8 s → sub 1 s): **Soniox** (~$1-2/lună, română de primă clasă),
**Azure** (deja integrat, `SPEECH_PROVIDER=azure_sdk`, F0 gratuit 5 h/lună) sau
**OpenAI Realtime transcription** (același model/preț, dar streaming). Tabele
comparative cu prețuri în raportul de audit.
