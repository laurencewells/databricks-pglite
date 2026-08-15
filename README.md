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

The application provides a read-only database browser alongside a checkpoint status summary and details disclosure. The browser lets authenticated callers inspect the connected database's user schemas and paginated table rows without exposing write controls. The summary shows changes that exist only in local PGlite; its details disclosure lists the last checkpoint timestamp, archive filename, and archive restored during startup.

## Important constraints

- Keep Databricks App horizontal scaling disabled. Multiple instances would create independent databases and race over the snapshot pointer.
- A crash can lose every write after the last successful checkpoint.
- The shared PGlite database does not inherit Unity Catalog row or column policies. Every identity with `CAN_USE` can inspect the same database contents and can execute the trusted SQL endpoint.
- `pglite-socket` and PostgreSQL port 5432 are not exposed. The app uses the single HTTP listener supplied through `DATABRICKS_APP_PORT`.
- AppKit accesses the Volume as the application service principal. Its generic file routes deny end-user operations on the snapshot resource.

## Local development

Requirements: Node.js 22+, GNU Make, and Docker for the container path.

```bash
make install
make local
```

Open `http://localhost:8000`. Local state lives under `.data/`.

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

The test suite (`npm test` / `just test`) has known Windows-only failures — not a sign the app is broken, just platform gaps in the tests themselves:
- A handful of tests that create a real PGlite instance run close to or past vitest's default 5s timeout, since PGlite cold-starts noticeably slower on Windows than on Linux/macOS CI.
- The Makefile-workflow test shells out to `make`, which isn't installed here.
- One snapshot-store test simulates a read-only `latest.json` and rewrites it via rename; POSIX rename ignores the destination file's permissions, but Windows/NTFS blocks renaming over a read-only file.
- One integration test triggers graceful shutdown with `child.kill("SIGTERM")`; Windows has no trappable POSIX signals, so `SIGTERM`/`SIGINT` sent this way always hard-kill the process instead of running the app's shutdown handler.

None of these affect the running app — they're artifacts of the test harness on Windows.

## Test against a Databricks Volume

The Makefile defaults to the valid `ps` Databricks CLI profile. After the dev bundle has created its catalog, schema, and Volume:

```bash
make local-volume PROFILE=ps
```

This keeps live PGlite state locally but uploads and restores snapshots through AppKit using `/Volumes/pglite_app_dev/app/snapshots`.

## Deploy with Databricks Asset Bundles

Read-only validation:

```bash
make validate PROFILE=ps TARGET=dev
```

Build, deploy, and start the app:

```bash
make deploy-run PROFILE=ps TARGET=dev
make app-url PROFILE=ps
```

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
3. Run `make run PROFILE=ps TARGET=dev` to restart the app.
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
make destroy CONFIRM=1 PROFILE=ps   # destructive
```
