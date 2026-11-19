# Nexus editor backend — W4 contract (endpoint map)

The editor frontend (prototype today, the React port later) talks to
the editor backend **only** through the NexusWire Backend contract.
Local storage is the always-available layer (local = cache/fallback);
in HTTP mode the same operations write through to this API, editor
commands stream to it in batches, and boot reconciles local vs
server by `manifest.savedAt` — newest wins.

Base URL (prototype default): `http://127.0.0.1:8921`
All bodies are the GameProject document JSON verbatim
(`{formatVersion, kind:"nexus-game-project", manifest, sections}`).

| Method | Route | Body → Response |
|---|---|---|
| GET | `/api/health` | → `{ok, service, time}` |
| GET | `/api/projects/:id/draft` | → the draft document, or 404 |
| PUT | `/api/projects/:id/draft` | document → `{ok, savedAt}`; 422 if `kind` isn't `nexus-game-project` |
| GET | `/api/projects/:id/versions` | → `[{v, name, when, note}]` |
| PUT | `/api/projects/:id/versions/:v` | `{doc, meta}` → `{ok, v}` |
| GET | `/api/projects/:id/versions/:v` | → the version's full document, or 404 |
| POST | `/api/projects/:id/commands` | `{commands:[{seq,t,type,what,why}]}` → `{ok, accepted}` |
| GET | `/api/projects/:id/commands/count` | → `{count}` (reference-server convenience) |

Rules that are part of the contract, not implementation detail:

- **Fail closed on documents.** A PUT whose body isn't a
  `nexus-game-project` document is refused (422); the frontend's
  importer likewise validates kind + formatVersion + required
  sections before hydrating anything.
- **Versions are immutable.** PUT to an existing version number
  overwrites only in the reference server's file store; the
  production service should reject re-writing a published version.
- **Commands are append-only** and carry the editor's own verb
  names — the same stream the command bus logs locally.
- **The world server is not this API.** This is the authoring
  tier (Node + Express in production); the uWS gateway and the
  SurrealDB world store stay separate, per the standing split.

`server.mjs` in this folder is a zero-dependency reference
implementation (file storage) used to prove the prototype loop end
to end: frontend → HTTP → disk → server restart → frontend
recovers its game from the server alone.
