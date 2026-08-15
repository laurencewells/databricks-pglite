# PGlite durability lab

## Architecture

- PGlite is embedded in one Node.js process and is not exposed through PostgreSQL wire protocol.
- Authenticated callers use HTTPS APIs through the Databricks Apps proxy.
- Live database files are ephemeral. Full immutable archives are checkpointed to a Unity Catalog Volume.
- Do not place live PostgreSQL files on `/Volumes`.

## Durability

- `SNAPSHOT_INTERVAL_MS` defaults to 30000 milliseconds.
- The development deployment retains a rolling 10 archives.
- Automatic checkpoints run only after writes.
- Preserve manual checkpoints and the graceful-shutdown checkpoint lifecycle.
- Read-only operations must not mark the database dirty.

## Database browser

- `WEB_UI_ENABLED` defaults to `true` and controls frontend delivery only.
- Browser APIs remain available when the frontend is disabled.
- Browser APIs are read-only: never accept arbitrary SQL or expose write operations.
- Show only the connected database and user schemas/tables; exclude PostgreSQL and PGlite internals.
- Validate catalog objects before quoting identifiers and querying rows.

## Testing and deployment

- Keep tests lightweight and backend-focused.
- Frontend component tests are intentionally omitted; use type checking and the production build.
- Use Databricks CLI profile `ps` and bundle target `dev` for the development deployment.
- Run `make test` before deployment.
