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
- `/translate`
- `/song`
- `/participant`

## Environment variables

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TRANSCRIBE_MODEL`
- `PORT`

Valori implicite recomandate:

- `OPENAI_MODEL=gpt-4.1-nano`
- `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`

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

## Observatii

- actiunile de administrare folosesc `adminCode`
- participant audio foloseste browser speech synthesis
- daca OpenAI nu este configurat, aplicatia poate rula in mod fallback pentru test de UI
