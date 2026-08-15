import { format } from "node:util";
import express from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import {
  BrowserTableNotFoundError,
  type BrowserRowsInput,
  type BrowserRowsPage,
  type DatabaseCatalog,
} from "./database-browser.js";
import type { Note } from "./database.js";
import { MutationDrain } from "./mutation-drain.js";
import { registerRoutes } from "./routes.js";
import type { SnapshotManifest } from "./snapshots/manifest.js";
import type { SnapshotStatus } from "./snapshots/service.js";

function testApplication(
  options: {
    failNoteWrite?: boolean;
    onQuery?: (text: string, values: readonly unknown[]) => void;
    failQuery?: boolean;
    environment?: string;
    allowLocalIdentity?: boolean;
    webUiEnabled?: boolean;
    checkpointIntervalMs?: number;
    mutations?: MutationDrain;
    catalog?: DatabaseCatalog;
    rowsPage?: BrowserRowsPage;
    rowsError?: Error;
    onRows?: (input: BrowserRowsInput) => void;
  } = {},
) {
  const notes: Note[] = [];
  let checkpointCount = 0;
  const app = express();
  registerRoutes(app, {
    environment: options.environment ?? "production",
    allowLocalIdentity: options.allowLocalIdentity,
    database: {
      async listNotes() {
        return notes;
      },
      async addNote(body, createdBy) {
        if (options.failNoteWrite) {
          throw new Error("sensitive /Volumes/catalog/schema path");
        }
        const note = {
          id: `note-${notes.length + 1}`,
          body,
          createdBy,
          createdAt: "2026-08-13 08:00:00+00",
        };
        notes.unshift(note);
        return note;
      },
      async query<T extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        options.onQuery?.(text, values);
        if (options.failQuery) {
          throw Object.assign(new Error("PGlite query failed"), {
            query: text,
            params: values,
            detail: "syntax failure near sensitive_customer_table",
          });
        }
        return {
          rows: [{ answer: 42 }] as unknown as T[],
          rowCount: 1,
        };
      },
    },
    snapshots: {
      status(): SnapshotStatus {
        return {
          mode: "appkit",
          pendingWrites: notes.length,
          checkpointing: false,
          lastCheckpointAt:
            checkpointCount > 0 ? "2026-08-13T08:01:00.000Z" : null,
          lastArchive:
            checkpointCount > 0 ? "snapshots/checkpoint.tar.gz" : null,
          restoredFrom: null,
        };
      },
      async checkpoint(): Promise<SnapshotManifest> {
        checkpointCount += 1;
        return {
          version: 1,
          archive: "snapshots/checkpoint.tar.gz",
          sha256: "a".repeat(64),
          bytes: 123,
          createdAt: "2026-08-13T08:01:00.000Z",
          retainedArchives: [],
        };
      },
    },
    mutations: options.mutations ?? new MutationDrain(),
    browser: {
      async catalog() {
        return options.catalog ?? {
          database: "postgres",
          schemas: [{ name: "public", tables: ["demo_customer"] }],
        };
      },
      async rows(input) {
        options.onRows?.(input);
        if (options.rowsError) throw options.rowsError;
        return options.rowsPage ?? {
          schema: input.schema,
          table: input.table,
          columns: ["id"],
          rows: [{ id: "demo-alice" }],
          totalRows: 1,
          limit: input.limit,
          offset: input.offset,
        };
      },
    },
    webUiEnabled: options.webUiEnabled ?? true,
    checkpointIntervalMs: options.checkpointIntervalMs ?? 30_000,
  });
  return app;
}

const identityHeaders = {
  "x-forwarded-user": "user-123",
  "x-forwarded-preferred-username": "alice@example.com",
};

describe("application routes", () => {
  test("requires Databricks proxy identity before validating trusted SQL", async () => {
    await request(testApplication())
      .post("/api/v1/sql/query")
      .send({ text: "   ", values: [] })
      .expect(401, { error: "Databricks proxy identity is required" });
  });

  test("does not permit the local identity fallback for trusted SQL in production", async () => {
    await request(testApplication({ allowLocalIdentity: true }))
      .post("/api/v1/sql/query")
      .send({ text: "SELECT 1", values: [] })
      .expect(401, { error: "Databricks proxy identity is required" });
  });

  test("permits the local identity fallback for trusted SQL in development", async () => {
    await request(testApplication({ environment: "development" }))
      .post("/api/v1/sql/query")
      .send({ text: "SELECT 1", values: [] })
      .expect(200, { rows: [{ answer: 42 }], rowCount: 1 });
  });

  test("forwards SQL and values for any authenticated ingress identity", async () => {
    let query:
      | { text: string; values: readonly unknown[] }
      | undefined;
    const app = testApplication({
      onQuery(text, values) {
        query = { text, values };
      },
    });

    await request(app)
      .post("/api/v1/sql/query")
      .set({
        "x-forwarded-user": "partner-app-456",
        "x-forwarded-preferred-username": "Partner application",
      })
      .send({ text: "SELECT $1::int AS answer", values: [42] })
      .expect(200, { rows: [{ answer: 42 }], rowCount: 1 });

    expect(query).toEqual({
      text: "SELECT $1::int AS answer",
      values: [42],
    });
  });

  test("redacts SQL failures and limits audit logs to safe metadata", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    await request(
      testApplication({
        failQuery: true,
      }),
    )
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .set("authorization", "Bearer secret-token")
      .send({
        text: "SELECT * FROM sensitive_customer_table WHERE id = $1",
        values: ["customer-secret"],
      })
      .expect(500, { error: "Internal server error" });

    expect(consoleInfo).toHaveBeenCalledOnce();
    expect(consoleInfo).toHaveBeenCalledWith({
      requestId: expect.any(String),
      callerId: "user-123",
      durationMs: expect.any(Number),
      outcome: "failure",
    });
    expect(JSON.stringify(consoleInfo.mock.calls)).not.toMatch(
      /sensitive_customer_table|customer-secret|secret-token|authorization/i,
    );
    expect(consoleError).toHaveBeenCalled();
    expect(
      consoleError.mock.calls
        .map((arguments_) => format(...arguments_))
        .join("\n"),
    ).not.toMatch(
      /sensitive_customer_table|customer-secret|secret-token|authorization/i,
    );

    consoleInfo.mockRestore();
    consoleError.mockRestore();
  });

  test("stores the authenticated creator with a valid note", async () => {
    const app = testApplication();

    const created = await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "Checkpoint before changing the schema" })
      .expect(201);
    const listed = await request(app)
      .get("/api/notes")
      .set(identityHeaders)
      .expect(200);

    expect(created.body.note).toMatchObject({
      body: "Checkpoint before changing the schema",
      createdBy: "alice@example.com",
    });
    expect(listed.body.notes).toEqual([created.body.note]);
  });

  test("rejects blank and oversized notes", async () => {
    const app = testApplication();

    await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "   " })
      .expect(400, {
        error: "Note must be between 1 and 500 characters",
      });
    await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "x".repeat(501) })
      .expect(400);
  });

  test("returns durability status and promotes a manual checkpoint", async () => {
    const app = testApplication();

    const initial = await request(app)
      .get("/api/app/status")
      .set(identityHeaders)
      .expect(200);
    const checkpoint = await request(app)
      .post("/api/checkpoints")
      .set(identityHeaders)
      .expect(201);

    expect(initial.body).toMatchObject({
      user: { displayName: "alice@example.com" },
      durability: { mode: "appkit", lastCheckpointAt: null },
      configuration: { checkpointIntervalMs: 30_000 },
    });
    expect(checkpoint.body.manifest.archive).toBe(
      "snapshots/checkpoint.tar.gz",
    );
    expect(checkpoint.body.durability.lastCheckpointAt).toBe(
      "2026-08-13T08:01:00.000Z",
    );
  });

  test("rejects new database and checkpoint mutations after shutdown starts", async () => {
    const mutations = new MutationDrain();
    await mutations.quiesce();
    const app = testApplication({ mutations });

    await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "late mutation" })
      .expect(503, { error: "Database mutations are unavailable during shutdown" });
    await request(app)
      .post("/api/checkpoints")
      .set(identityHeaders)
      .expect(503, { error: "Database mutations are unavailable during shutdown" });
    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "SELECT 1", values: [] })
      .expect(503, { error: "Database mutations are unavailable during shutdown" });
  });

  test("rejects requests that bypass the Databricks proxy", async () => {
    await request(testApplication()).get("/api/notes").expect(401, {
      error: "Databricks proxy identity is required",
    });
  });

  test("returns authenticated browser catalog and paginated rows", async () => {
    const rowInputs: BrowserRowsInput[] = [];
    const app = testApplication({
      onRows(input) {
        rowInputs.push(input);
      },
    });

    await request(app)
      .get("/api/browser/catalog")
      .set(identityHeaders)
      .expect(200, {
        database: "postgres",
        schemas: [{ name: "public", tables: ["demo_customer"] }],
      });
    await request(app)
      .get("/api/browser/rows")
      .query({ schema: "public", table: "demo_customer", limit: 50, offset: 0 })
      .set(identityHeaders)
      .expect(200);

    expect(rowInputs).toEqual([
      { schema: "public", table: "demo_customer", limit: 50, offset: 0 },
    ]);
  });

  test("rejects unauthenticated and invalid browser row requests", async () => {
    const app = testApplication();

    await request(app).get("/api/browser/catalog").expect(401);
    await request(app)
      .get("/api/browser/rows")
      .query({ schema: "public", table: "demo_customer", limit: 101 })
      .set(identityHeaders)
      .expect(400, { error: "Invalid browser row request" });
  });

  test("reports browser tables missing from the catalog as not found", async () => {
    const app = testApplication({ rowsError: new BrowserTableNotFoundError() });

    await request(app)
      .get("/api/browser/rows")
      .query({ schema: "public", table: "removed_table" })
      .set(identityHeaders)
      .expect(404, { error: "Table not found" });
  });

  test("disables frontend delivery without disabling APIs", async () => {
    const app = testApplication({ webUiEnabled: false });

    await request(app).get("/").set(identityHeaders).expect(404);
    await request(app).get("/assets/app.js").set(identityHeaders).expect(404);
    await request(app).get("/api/app/status").set(identityHeaders).expect(200);
    await request(app)
      .get("/api/browser/catalog")
      .set(identityHeaders)
      .expect(200);
  });

  test("returns safe client errors for malformed and oversized JSON", async () => {
    const app = testApplication();

    await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .set("content-type", "application/json")
      .send('{"body":')
      .expect(400, { error: "Malformed JSON request body" });
    await request(app)
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "x".repeat(17_000) })
      .expect(413, { error: "Request body is too large" });
  });

  test("does not expose internal exception details in production", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(testApplication({ failNoteWrite: true }))
      .post("/api/notes")
      .set(identityHeaders)
      .send({ body: "trigger storage error" })
      .expect(500, { error: "Internal server error" });

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
