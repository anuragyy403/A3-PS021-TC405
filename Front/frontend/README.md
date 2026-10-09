# Nighthawks dashboard (PS-021)

React 18 + Vite 5 + Tailwind dashboard for the PS-021 **experimental** dialog
correlation and recovery backend (`../../backend`). It is a hackathon prototype:
not a production system, not a protocol standard, and not exactly-once delivery.

The dashboard holds no experiment state of its own. Every number, task and
event comes from the backend API (`docs/API_DESIGN.md`), read by
`src/api/useBackendEngine.js`.

## Running it

The backend must be running first:

```bash
cd backend && npm run dev          # Express API on http://localhost:3001
cd Front/frontend && npm run dev   # dashboard on http://localhost:5173
```

The Vite dev server proxies `/api` and `/health` to the backend, so the browser
talks to one origin and the backend needs no CORS. Point it elsewhere with
`VITE_BACKEND_URL` (see `.env.example`; copy to `.env.local`).

If the backend is not reachable the header shows **Disconnected**, the manual
controls are paused, and polling backs off and reconnects on its own.

## How it works

- **Polling** (`src/api/useBackendEngine.js`): `GET /api/events?since=<cursor>`
  while the tab is visible, `GET /api/state` after new events (and every few
  seconds), `GET /api/dialogs/:id` only for tasks named in new events,
  `GET /api/scenarios` on load and after runs. A hidden tab stops polling; a
  manual action forces one poll.
- **Mapping** (`src/api/mappers.js`): backend JSON → what the components read.
  Fields with no backend source are not invented.
- **Wording** (`src/lib/narrate.js`, `src/api/messages.js`,
  `src/lib/constants.js`): plain-language feed lines, error texts and scenario
  card copy. Lifecycle = the backend's five states: INITIATED, PROCESSING,
  COMMITTED, RECOVERED, FAILED.
- **Demonstrations**: each card runs `POST /api/scenarios/:id/run`, the backend
  scenario script for that case.
- **Manual controls** (`src/components/ManualControls.jsx`): new task, send
  (optionally losing the request or the reply), retry a seq, send a duplicate,
  complete, abort, restart Adapter A/B. One API call per click; nothing is
  retried automatically. Restart A and B both restart the whole backend process
  from its SQLite file.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the backend proxy |
| `npm run build` | production build into `dist/` |
| `npm run lint` | oxlint over `src/` |
| `npm test` | `tests/mappers.mjs`, `tests/messages.mjs`, `tests/backendEngine.mjs` |

The tests are plain Node scripts and need no backend: `mappers.mjs` checks the
mappers against real captured responses in `tests/fixtures/`, `messages.mjs`
the user-facing texts, and `backendEngine.mjs` mounts the hook, the manual
controls and the whole App in jsdom against a scripted fake `fetch`.

Two helper scripts need a running backend and are not part of `npm test`:

- `node tests/backend-smoke.mjs` — exercises `src/api/client.js` against it.
- `node tests/capture-fixtures.mjs` — re-captures `tests/fixtures/` (it resets
  the backend first).
