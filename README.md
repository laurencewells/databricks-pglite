# PGlite durability lab for Databricks Apps

This proof-of-concept runs PGlite inside one TypeScript Databricks App instance. PostgreSQL files stay on the app's ephemeral local disk. The app periodically writes immutable, checksummed PGlite archives to a managed Unity Catalog Volume through the `@databricks/appkit` Files plugin.

It intentionally accepts an interval of possible data loss. It does **not** treat `/Volumes` as a PostgreSQL filesystem: Databricks Volumes do not support the random-write semantics PostgreSQL requires.

## Architecture

```text
Databricks OAuth proxy
        │ HTTPS
        ▼
AppKit server + React UI ── in-process ── PGlite on /tmp
        │                                      │
        └── AppKit Files API ◀── tar.gz dump ──┘
                    │
                    ▼
          Unity Catalog Volume
```

The original application provides a read-only database browser alongside a checkpoint status summary and details disclosure. The same durability layer can also supervise another application process and give it a loopback-only PostgreSQL connection. The browser lets authenticated callers inspect the connected database's user schemas and paginated table rows without exposing write controls. The summary shows changes that exist only in local PGlite; its details disclosure lists the last checkpoint timestamp, archive filename, and archive restored during startup.

## Important constraints

- Keep Databricks App horizontal scaling disabled. Multiple instances would create independent databases and race over the snapshot pointer.
- A crash can lose every write after the last successful checkpoint.
- The shared PGlite database does not inherit Unity Catalog row or column policies. Every identity with `CAN_USE` can inspect the same database contents and can execute the trusted SQL endpoint.
- Sidecar mode binds `pglite-socket` only to literal `127.0.0.1`; never expose its PostgreSQL port outside the app container. The supervised child remains the only externally served application.
- AppKit accesses the Volume as the application service principal. Its generic file routes deny end-user operations on the snapshot resource.

## Local development

Requirements: Node.js 22+, GNU Make, and Docker for the container path.

```bash
make install
make local
```

Open `http://localhost:8000`. Local state lives under `.data/`.

## Run PGlite beside a Python app

The runnable FastAPI example in `examples/python` exposes:

- `GET /health` to verify its PGlite connection;
- `POST /notes` with `{"body":"..."}` to write a durable note;
- `GET /notes` to list notes in insertion order.

Install [`uv`](https://docs.astral.sh/uv/), build the server once, and start the
pinned Python project through the sidecar:

```bash
npm run build:server
npm run start:python-example
```

Then exercise it locally:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/notes \
  -H 'content-type: application/json' \
  -d '{"body":"durable from Python"}'
curl http://localhost:8000/notes
```

The sidecar restores the latest valid snapshot, opens PostgreSQL on `127.0.0.1`, and then launches the child without a shell. It injects both `DATABASE_URL` (standard PostgreSQL) and `LOCAL_PG_DSN` (SQLAlchemy asyncpg) into that child. It never prints either DSN or the child environment. `make sidecar-smoke` and `just sidecar-smoke` exercise the production build with a short-lived Node child.

Sidecar configuration:

- `PGLITE_DATA_DIR` is ephemeral live database storage and defaults to `.data/pglite`.
- `SNAPSHOT_MODE` is `filesystem` by default or `appkit` for a Databricks Volume.
- `SNAPSHOT_DIRECTORY` is the archive directory in filesystem mode.
- `DATABRICKS_VOLUME_FILES` must be an absolute `/Volumes/<catalog>/<schema>/<volume>` root in AppKit mode. Bind that Volume to the app service principal with read/write access.
- `PGLITE_SOCKET_HOST` must remain `127.0.0.1`; `PGLITE_SOCKET_PORT` defaults to `5432`.
- `PGLITE_SOCKET_MAX_CONNECTIONS` defaults to `1`. Keep the child connection pool within that limit.
- `SNAPSHOT_INTERVAL_MS` defaults to `30000`, `SNAPSHOT_RETENTION` to `3`, and `SIDECAR_SHUTDOWN_TIMEOUT_MS` to `10000`.

Only one sidecar instance may own a database and snapshot root. Checkpoints are coordinated with socket execution so they do not cross transaction progress, and read-only SQL does not create archives. On shutdown the supervisor terminates the child, stops new socket work, checkpoints committed writes, and closes PGlite. A crash can still lose writes made since the last successful checkpoint; this is checkpoint durability, not synchronous PostgreSQL durability.

This mode coexists with the original Express/React application. Use `npm start` for the original app and `npm run start:sidecar -- -- <command...>` for a supervised child.

To run the same production image with snapshots bind-mounted from the host:

```bash
make docker-build
make docker-run
```

The image keeps live PGlite files under `/tmp/pglite/data` and snapshots under the `/snapshots` mount. Removing the container and starting it again exercises archive restoration. Filesystem mode uses a standalone Express server, so local Node and Docker runs do not require Databricks credentials. It exposes only the HTTP port; PGlite remains in-process and never opens PostgreSQL port 5432.

### Windows

`make` isn't installed by default on Windows. Use the equivalent [`just`](https://just.systems) recipes instead (`just install`, `just local`, `just docker-build`/`docker-run` — the latter default to `podman`, override with `CONTAINER_ENGINE=docker`). `just` requires a POSIX `sh` on PATH, which Git for Windows already provides.

Don't run `npm run dev` or `npm start` directly from PowerShell/cmd: those scripts set env vars with `VAR=val cmd` syntax, and npm always launches scripts through `cmd.exe` on Windows regardless of the calling shell, so it fails with `'NODE_ENV' is not recognized...`. `just local`/`just local-volume` sidestep this by invoking `tsx` directly.

The first PGlite cold start (a fresh `.data/pglite` or a Windows Firewall/Defender prompt for `node.exe`) can take a couple of minutes; later starts reusing the same data directory are fast.

The test suite (`npm test` / `just test`) has known Windows-only failures (PGlite cold-start timing vs. vitest's default timeout, a missing `make` binary, and NTFS/signal differences from POSIX) — these are test-harness artifacts, not signs the app is broken.

## Test against a Databricks Volume

The Makefile defaults to the `DEFAULT` Databricks CLI profile. After the dev bundle has created its catalog, schema, and Volume:

```bash
make local-volume PROFILE=DEFAULT
```

This keeps live PGlite state locally but uploads and restores snapshots through AppKit using `/Volumes/pglite_app_dev/app/snapshots`.

## Deploy with Databricks Asset Bundles

Read-only validation:

```bash
make validate PROFILE=DEFAULT TARGET=dev
```

Build, deploy, and start the app:

```bash
make deploy-run PROFILE=DEFAULT TARGET=dev
make app-url PROFILE=DEFAULT
```

To deploy the runnable Python example instead, use the opt-in target. The
standard Node/browser app remains the default for later deployments:

```bash
make deploy-python
# Windows-friendly equivalent:
just deploy-python
```

Both commands default to Databricks CLI profile `DEFAULT` and bundle target
`dev`; override `PROFILE` or `TARGET` through the existing environment
variables when needed.

The bundle provisions:

- managed catalog `pglite_app_dev`;
- schema `app`;
- managed Volume `snapshots`;
- the Databricks App and its service principal;
- a `WRITE_VOLUME` app resource binding.

The bundle deliberately grants no default `CAN_USE` permission. Grant `CAN_USE`
to a trusted consumer service principal explicitly outside the bundle before it
uses the app. Do not grant broad users or groups `CAN_USE`.

Override bundle variables in the normal DAB way or edit the target variables before using this outside a development workspace.

Deployment temporarily rewrites the developer lockfile's Databricks npm proxy URLs to public npm URLs. The original lockfile is restored even when deployment fails.

## Trusted SQL API

`POST /api/v1/sql/query` is only for trusted customer Databricks Apps that
would otherwise receive database credentials. It grants effectively full
embedded-database access. Ordinary consumers should use the domain API instead.

Access is enforced by Databricks App `CAN_USE`: every identity with `CAN_USE`
can execute SQL. There is no separate SQL caller-ID allowlist or runtime
configuration. Treat `CAN_USE` as a database credential: grant trusted consumer
service principals individually outside the bundle, and never grant broad users
or groups `CAN_USE`.

This is authenticated HTTPS, not the PostgreSQL wire protocol. `psql`, JDBC,
and normal PostgreSQL drivers cannot connect to it. Use parameterized SQL with
`$1`, `$2`, and so on; never interpolate values into SQL text.

Query parameters use a deliberately JSON-portable contract: `null`, booleans,
finite numbers, strings, arrays, and plain objects containing only those values.
`bigint`, `Date`, `Uint8Array`/`Buffer`, `undefined`, `NaN`, and infinities are
rejected before a token is requested or a network call is made. Send large
integers as decimal strings and cast them with `$1::bigint` or `$1::numeric`;
send dates as ISO strings and cast them with `$1::timestamptz`; send binary data
as base64 strings and decode it with `decode($1, 'base64')`. Use `null` instead
of `undefined`. If PostgreSQL non-finite numeric semantics are intentional,
send `"NaN"`, `"Infinity"`, or `"-Infinity"` as a string and cast it with
`$1::double precision`.

Results are normalized identically by the HTTPS client and `adaptPgPool`:
PostgreSQL `int8`/driver `bigint` becomes a decimal string, timestamps returned
as `Date` become ISO strings, and `bytea`/`Uint8Array` becomes unprefixed base64.
The same repository row types therefore work before and after the Lakebase
migration. A pg driver's non-null `rowCount` is preserved; only `null` falls
back to `rows.length`.

```bash
curl --request POST "$PGLITE_APP_URL/api/v1/sql/query" \
  --header "Authorization: Bearer <short-lived-Databricks-token>" \
  --header "Content-Type: application/json" \
  --data '{"text":"select id, body from note where id = $1","values":["<note-id>"]}'
```

Repository-owning consumers can use `RemoteQueryable` now without embedding
credentials; the token provider obtains a short-lived token for each request.
When Lakebase is available, retain repository SQL and replace this adapter with
`adaptPgPool(new pg.Pool(...))`.

```ts
import { RemoteQueryable } from "./sdk/remote-queryable.js";

// Provided by this consumer app's Databricks OAuth integration.
declare function getShortLivedDatabricksToken(): Promise<string>;

const database = new RemoteQueryable({
  baseUrl: process.env.PGLITE_APP_URL!,
  getAccessToken: () => getShortLivedDatabricksToken(),
});

const result = await database.query<{ body: string }>(
  "select body from note where id = $1",
  [noteId],
);
```

## Recovery smoke test

1. Use a trusted SQL client to add a test row, then open the deployed app and confirm that the read-only browser displays it.
2. Select **Checkpoint now** and verify the checkpoint status summary reports “All changes checkpointed.”
3. Run `make run PROFILE=DEFAULT TARGET=dev` to restart the app.
4. Reload the app and confirm the row returns and the checkpoint details disclosure shows the restored archive.
5. Add another row without checkpointing, restart again, and observe that the second row can be lost. That is the accepted recovery window.

On a graceful shutdown, the app stops accepting requests, checkpoints pending writes, and then closes PGlite. The same checkpoint lifecycle is registered with the Databricks App runtime; a crash can still lose writes after the last successful checkpoint.

## Operations

- `WEB_UI_ENABLED=true` serves the read-only database browser; set it to `false` to disable only frontend delivery.
- `SNAPSHOT_INTERVAL_MS=30000` checks for pending writes every 30 seconds.
- The development target keeps `SNAPSHOT_RETENTION=10` immutable archives and deletes older generations after pointer promotion.
- Browser endpoints expose only catalog metadata and paginated table reads. Each page validates its selected user table and reads metadata, count, and rows from one repeatable-read snapshot; primary-key columns order pages, with `tableoid, ctid` as the keyless fallback. They do not replace the trusted SQL API.

Snapshot promotion writes the archive first, then `latest.json`; older generations are removed only after the new pointer succeeds. Startup verifies both byte length and SHA-256 before loading an archive.

Bundle destruction is confirmation-gated:

```bash
make destroy                         # dry-run only
make destroy CONFIRM=1 PROFILE=DEFAULT   # destructive
```
