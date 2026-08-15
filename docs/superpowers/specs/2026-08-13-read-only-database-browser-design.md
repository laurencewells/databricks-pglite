# Read-only database browser design

## Goal

Replace the field-notes example interface with a small authenticated, read-only browser for the embedded PGlite database while preserving the existing durability ledger and checkpoint lifecycle.

The browser shows the connected database, its user-created schemas and tables, and paginated table rows. The connected database is currently `postgres`; PGlite exposes one connected database rather than a multi-database server.

## Runtime configuration

- `WEB_UI_ENABLED` controls whether frontend pages and static assets are served. It defaults to `true`.
- When `WEB_UI_ENABLED=false`, frontend requests return 404 while authenticated APIs remain available.
- `SNAPSHOT_INTERVAL_MS` remains configurable with a 30-second default.
- `SNAPSHOT_RETENTION` remains configurable and the development deployment retains a rolling 10 archives.
- Automatic, manual, and graceful-shutdown checkpoints remain enabled.
- Automatic checkpoints run only when the database has pending writes.

## Read-only browser API

Add two authenticated endpoints:

- `GET /api/browser/catalog` returns the connected database name and user-created schemas and tables.
- `GET /api/browser/rows?schema=<schema>&table=<table>&limit=<limit>&offset=<offset>` returns one page of rows and the total row count.

System schemas and internal PGlite objects are excluded. This includes `pg_catalog`, `information_schema`, and schemas with PostgreSQL internal prefixes.

The row endpoint defaults to 50 rows and enforces a maximum request size of 100 rows. Offset must be a non-negative integer. It accepts no SQL text.

Before reading rows, the server verifies the exact schema and table pair against PostgreSQL catalog metadata. Only then does it quote the identifiers and issue a `SELECT`. The API provides no insert, update, delete, or DDL operation. The existing trusted SQL API remains unchanged for explicitly trusted callers.

## Frontend

Use the approved “catalog rail + data sheet” layout:

- The left rail shows the connected database, user schemas, and their tables.
- Selecting a table loads its first 50 rows.
- The central data sheet renders arbitrary columns and JSON-safe cell values.
- Previous and next controls page through rows.
- The existing right-hand durability ledger remains visible, including pending writes, last checkpoint, manual checkpoint action, and the configured 30-second interval.
- Empty catalogs, empty tables, stale table selections, and request failures have explicit states.
- The UI contains no data-writing controls.

The existing mineral/ink visual identity remains, adapted from a notebook into a compact database inspector. The catalog hierarchy is the signature visual element. The layout collapses cleanly on narrow screens, and native controls retain keyboard focus behavior.

## Existing notes example

The notes interface is removed from the frontend. Existing note data and backend compatibility routes may remain because the browser should be able to inspect the `note` table and removing APIs is unnecessary scope.

## Testing policy

Keep tests lightweight and backend-focused:

- Test strict boolean parsing and the default for `WEB_UI_ENABLED`.
- Test authenticated catalog responses and system-schema filtering.
- Test row pagination, request validation, exact catalog lookup, and safe identifier handling.
- Test that disabling the UI returns 404 for frontend routes without disabling APIs.
- Retain existing durability, trusted SQL, and integration coverage.
- Remove the frontend component test suite and do not add new frontend tests for this proof of concept.
- Run type checking and the production build to verify frontend compilation.

## Project guidance

Add a root `AGENTS.md` that records:

- PGlite is embedded and reachable through authenticated HTTPS, not PostgreSQL wire protocol.
- Live data resides on ephemeral local disk and is checkpointed as full immutable archives to a Unity Catalog Volume.
- The deployed development profile is `ps`.
- Checkpoint defaults are 30 seconds and rolling retention of 10 archives.
- The database browser API is read-only and must not accept arbitrary SQL.
- `WEB_UI_ENABLED` defaults on and affects only frontend delivery.
- Testing should remain lightweight and backend-focused; frontend component tests are intentionally omitted.
- Manual and graceful-shutdown checkpoints must be preserved.

## Deployment and verification

After implementation:

1. Run backend tests, type checking, and the production build.
2. Deploy the `dev` target through Databricks profile `ps`.
3. Confirm the app, deployment, and compute are healthy.
4. Confirm the catalog API returns `postgres` and user schemas/tables only.
5. Confirm the row API reads `demo_customer` with pagination and cannot access an invalid/system table.
6. Confirm the frontend displays the approved layout and remains read-only.
7. Confirm the durability ledger and manual checkpoint still work.
8. Confirm the deployed configuration uses a 30-second interval and retains 10 archives.
