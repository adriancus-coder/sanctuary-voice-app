# Sanctuary Voice

Sanctuary Voice este o aplicatie pentru traducere live in biserica, cu patru experiente conectate:

- `admin` pentru operator
- `translate` pentru ecranul principal
- `song` pentru texte pregatite si cantari
- `participant` pentru telefon

## Ce face

- transcrie audio live
- traduce in mai multe limbi
- trimite textul simultan catre ecranul principal si participanti
- permite prepared text / song mode
- pastreaza glossary si corectii pentru termeni

## Cerinte

- Node.js 18 sau mai nou
- o cheie `OPENAI_API_KEY`

## Setup local

1. Instaleaza dependintele:

```bash
npm install
```

2. Creeaza un fisier `.env` pornind de la `.env.example`

3. Porneste aplicatia:

```bash
npm start
```

4. Deschide:

- `/admin`
- `/main-screen`
- `/translate`
- `/song`
- `/participant`

## Environment variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TRANSCRIBE_MODEL`
- `TRANSCRIBE_RATE_LIMIT_WINDOW_MS`
- `TRANSCRIBE_RATE_LIMIT_MAX`
- `PUBLIC_BASE_URL`
- `ADMIN_APP_BASE_URL`
- `ADMIN_APP_HOSTNAMES`
- `MASTER_ADMIN_PIN`
- `MAIN_OPERATOR_PIN`
- `ADMIN_SESSION_SECRET`
- `ADMIN_SESSION_PERSISTENT`
- `COMMERCIAL_MODE`
- `DEFAULT_ORG_ID`
- `DEFAULT_ORG_NAME`
- `DEFAULT_ORG_PLAN`
- `PORT`

Valori implicite recomandate:

- `OPENAI_MODEL=gpt-4.1-nano`
- `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- `TRANSCRIBE_RATE_LIMIT_WINDOW_MS=60000`
- `TRANSCRIBE_RATE_LIMIT_MAX=40`
- `PUBLIC_BASE_URL=https://sanctuaryvoice.com`
- `ADMIN_APP_BASE_URL=https://app.sanctuaryvoice.com`
- `ADMIN_APP_HOSTNAMES=app.sanctuaryvoice.com,control.sanctuaryvoice.com,kontrol.sanctuaryvoice.com`
- `DEFAULT_ORG_ID=sanctuary-voice`
- `DEFAULT_ORG_NAME=Sanctuary Voice`

Endpoint-ul de transcriere este limitat implicit la 40 cereri pe minut pentru fiecare combinatie IP + eveniment. Socket.IO nu mai foloseste wildcard CORS; accepta doar `PUBLIC_BASE_URL` si `localhost` pentru test local.

## Commercial foundation

Aplicatia are o organizatie implicita. Evenimentele, codul permanent de operator, Church Library, Pinned Text Library si memoria/glossary permanenta sunt legate de aceasta organizatie. Pentru modul comercial seteaza:

- `COMMERCIAL_MODE=1`
- `MASTER_ADMIN_PIN=<pin-admin-secret>`
- `MAIN_OPERATOR_PIN=<pin-operator-secret>`
- `ADMIN_SESSION_SECRET=<long-random-secret>`
- `ADMIN_SESSION_PERSISTENT=0`

In modul comercial, crearea primului eveniment nu mai ramane deschisa public daca nu exista niciun eveniment. Pagina `/admin` cere login cu `MASTER_ADMIN_PIN`, iar sesiunea este pastrata intr-un cookie HttpOnly semnat cu `ADMIN_SESSION_SECRET`. Implicit, cookie-ul este doar pentru sesiunea curenta de browser, astfel incat Admin cere PIN din nou la o sesiune noua. Daca vrei sesiune persistenta, seteaza `ADMIN_SESSION_PERSISTENT=1`.

## Public site and Admin app domain

`sanctuaryvoice.com` serveste pagina publica de prezentare. Adminul ramane la `/admin`, dar poate fi mutat pe subdomeniul aplicatiei:

- `ADMIN_APP_BASE_URL=https://app.sanctuaryvoice.com`
- `ADMIN_APP_HOSTNAMES=app.sanctuaryvoice.com,control.sanctuaryvoice.com,kontrol.sanctuaryvoice.com`

Cu aceste valori, `sanctuaryvoice.com/admin` redirectioneaza catre `app.sanctuaryvoice.com/admin`, iar dupa login ramai in aplicatia organizatiei.

## Deploy pe Render cu New Web Service

Nu ai nevoie de Blueprint pentru acest proiect. Poti face deploy direct cu `New Web Service`.

In Render:

1. alege `New +` -> `Web Service`
2. conecteaza repository-ul
3. foloseste:

```text
Environment: Node
Build Command: npm install
Start Command: npm start
```

4. adauga environment variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL=gpt-4.1-nano`
- `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`

5. seteaza health check path:

```text
/api/health
```

Fisierul `render.yaml` poate ramane in proiect, dar nu este obligatoriu daca deploy-ul este facut manual din `New Web Service`.

## Backup sessions

`sessions.json` este salvat in `DATA_DIR`. La pornire si inainte de salvare, aplicatia creeaza cel mult o copie pe zi cu numele `sessions.backup-YYYY-MM-DD.json` in acelasi folder. Sunt pastrate ultimele 7 backup-uri.

## Observatii

- actiunile de administrare folosesc `adminCode`
- participant audio foloseste browser speech synthesis
- daca OpenAI nu este configurat, aplicatia poate rula in mod fallback pentru test de UI
