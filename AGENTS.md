# PGlite durability lab

## Architecture

- PGlite is embedded in one Node.js process and is not exposed through PostgreSQL wire protocol.
- Authenticated callers use HTTPS APIs through the Databricks Apps proxy.
- Live database files are ephemeral. Full immutable archives are checkpointed to a Unity Catalog Volume.
- Do not place live PostgreSQL files on `/Volumes`.
- The optional child-app sidecar is the only exception to the no-wire-protocol architecture: it binds PostgreSQL to literal `127.0.0.1` inside the same app container and must never listen on an external interface.
- Sidecar child commands are exact argv after `--`, are spawned without a shell, and receive database DSNs only through their environment. Never log DSNs or the child environment.

## Durability

- `SNAPSHOT_INTERVAL_MS` defaults to 30000 milliseconds.
- The development deployment retains a rolling 10 archives.
- Automatic checkpoints run only after writes.
- Preserve manual checkpoints and the graceful-shutdown checkpoint lifecycle.
- Read-only operations must not mark the database dirty.
- Sidecar checkpoints and socket protocol work share one execution barrier. Do not take a snapshot across transaction progress.
- Sidecar shutdown order is child, socket, final checkpoint, then PGlite. Keep it idempotent and bounded.
- Sidecar mode is single-instance and defaults to one PostgreSQL connection. Abrupt failure can lose every write after the last successful checkpoint.

## Database browser

- `WEB_UI_ENABLED` defaults to `true` and controls frontend delivery only.
- Browser APIs remain available when the frontend is disabled.
- Browser APIs are read-only: never accept arbitrary SQL or expose write operations.
- Show only the connected database and user schemas/tables; exclude PostgreSQL and PGlite internals.
- Validate catalog objects before quoting identifiers and querying rows.

## Testing and deployment

- Keep tests lightweight and backend-focused.
- Frontend component tests are intentionally omitted; use type checking and the production build.
- Use Databricks CLI profile `DEFAULT` and bundle target `dev` for the development deployment.
- Run `make test` before deployment.
- Run `make sidecar-smoke` when changing sidecar build or supervision behavior.
