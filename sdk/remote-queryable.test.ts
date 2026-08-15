import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  PortableSqlValue,
  Queryable,
} from "../shared/queryable.js";
import { DatabaseService } from "../server/database.js";
import { MutationDrain } from "../server/mutation-drain.js";
import { registerTrustedSqlRoute } from "../server/trusted-sql.js";
import { adaptPgPool, RemoteQueryable } from "./remote-queryable.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()));
});

async function loadNoteBodies(database: Queryable): Promise<string[]> {
  const result = await database.query<{ body: string }>(
    "SELECT body FROM note ORDER BY body",
  );
  return result.rows.map((row) => row.body);
}

async function startTrustedSqlServer(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "pglite-remote-queryable-"));
  const database = await DatabaseService.create({ dataDir });
  const application = express();
  application.use(express.json());
  registerTrustedSqlRoute(application, {
    environment: "development",
    allowLocalIdentity: true,
    database,
    mutations: new MutationDrain(),
  });

  const server = createServer(application);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Trusted SQL test server did not expose a TCP address");
  }

  cleanup.push(async () => {
    await closeServer(server);
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("RemoteQueryable", () => {
  test("serves a Queryable repository through the trusted SQL route", async () => {
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("service-token-1")
      .mockResolvedValueOnce("service-token-2");
    const authorizationHeaders: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      authorizationHeaders.push(headers.Authorization);
      return globalThis.fetch(input, init);
    };
    const database = new RemoteQueryable({
      baseUrl: `${await startTrustedSqlServer()}///`,
      getAccessToken,
      fetch,
    });

    await database.query(
      "INSERT INTO note (id, body, created_by) VALUES ($1, $2, $3)",
      ["note-1", "Remote repository", "service-principal"],
    );

    await expect(loadNoteBodies(database)).resolves.toEqual([
      "Remote repository",
    ]);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(authorizationHeaders).toEqual([
      "Bearer service-token-1",
      "Bearer service-token-2",
    ]);
  });

  test.each([
    {
      name: "bigint",
      value: 9_007_199_254_740_993n,
      message: /decimal string.*\$1::bigint/i,
    },
    {
      name: "binary",
      value: new Uint8Array([1, 2, 3]),
      message: /base64 string.*decode\(\$1, 'base64'\)/i,
    },
    {
      name: "undefined",
      value: undefined,
      message: /use null instead of undefined/i,
    },
    {
      name: "NaN",
      value: Number.NaN,
      message: /finite number/i,
    },
    {
      name: "positive infinity",
      value: Number.POSITIVE_INFINITY,
      message: /finite number/i,
    },
    {
      name: "negative infinity",
      value: Number.NEGATIVE_INFINITY,
      message: /finite number/i,
    },
    {
      name: "Date",
      value: new Date("2026-08-13T10:00:00.000Z"),
      message: /ISO string.*\$1::timestamptz/i,
    },
  ])(
    "rejects a non-portable $name parameter before authorization or transport",
    async ({ value, message }) => {
      const getAccessToken = vi.fn(async () => "unused-token");
      const fetch = vi.fn<typeof globalThis.fetch>();
      const database = new RemoteQueryable({
        baseUrl: "https://example.test",
        getAccessToken,
        fetch,
      });

      await expect(
        database.query("SELECT $1", [value] as never),
      ).rejects.toThrow(message);
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test("sends copied values and bearer authentication to the query endpoint", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({ rows: [{ answer: 42 }], rowCount: 1 }), {
        headers: { "content-type": "application/json" },
      });
    };
    const values: readonly PortableSqlValue[] = [42];
    const database = new RemoteQueryable({
      baseUrl: "https://example.test///",
      getAccessToken: async () => "access-token",
      fetch,
    });

    await expect(
      database.query<{ answer: number }>("SELECT $1::int AS answer", values),
    ).resolves.toEqual({ rows: [{ answer: 42 }], rowCount: 1 });

    expect(request).toMatchObject({
      input: "https://example.test/api/v1/sql/query",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      text: "SELECT $1::int AS answer",
      values: [42],
    });
  });

  test("snapshots portable parameters before asynchronous token acquisition", async () => {
    let requestBody: string | undefined;
    const values: PortableSqlValue[] = ["original"];
    const database = new RemoteQueryable({
      baseUrl: "https://example.test",
      getAccessToken: async () => {
        values[0] = 1n as never;
        return "access-token";
      },
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        return new Response(JSON.stringify({ rows: [], rowCount: 0 }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(database.query("SELECT $1::text", values)).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    expect(JSON.parse(String(requestBody))).toEqual({
      text: "SELECT $1::text",
      values: ["original"],
    });
  });

  test("rejects sparse top-level parameters before authorization or transport", async () => {
    const getAccessToken = vi.fn(async () => "unused-token");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const database = new RemoteQueryable({
      baseUrl: "https://example.test",
      getAccessToken,
      fetch,
    });
    const values = new Array<PortableSqlValue>(1);

    await expect(database.query("SELECT $1", values)).rejects.toThrow(
      /use null instead of undefined/i,
    );
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { name: "object", values: {} },
    { name: "string", values: "not-an-array" },
    { name: "typed array", values: new Uint8Array([1, 2, 3]) },
  ])(
    "rejects top-level $name parameter misuse before authorization or transport",
    async ({ values }) => {
      const getAccessToken = vi.fn(async () => "unused-token");
      const fetch = vi.fn<typeof globalThis.fetch>();
      const database = new RemoteQueryable({
        baseUrl: "https://example.test",
        getAccessToken,
        fetch,
      });

      await expect(
        database.query("SELECT 1", values as never),
      ).rejects.toThrow(
        "SQL parameters must be an array of portable values; pass [] when the query has no parameters.",
      );
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test("preserves literal __proto__ keys in portable object parameters", async () => {
    let requestBody: string | undefined;
    const database = new RemoteQueryable({
      baseUrl: "https://example.test",
      getAccessToken: async () => "access-token",
      fetch: async (_input, init) => {
        requestBody = String(init?.body);
        return new Response(JSON.stringify({ rows: [], rowCount: 0 }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const value = JSON.parse('{"__proto__":"literal-value"}') as PortableSqlValue;

    await database.query("SELECT $1::jsonb", [value]);

    expect(JSON.parse(String(requestBody))).toEqual({
      text: "SELECT $1::jsonb",
      values: [JSON.parse('{"__proto__":"literal-value"}')],
    });
  });

  test("rejects a failed request with the server's safe error", async () => {
    const database = new RemoteQueryable({
      baseUrl: "https://example.test",
      getAccessToken: async () => "access-token",
      fetch: async () =>
        new Response(JSON.stringify({ error: "Databricks proxy identity is required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(database.query("SELECT 1")).rejects.toThrow(
      "Trusted SQL request failed (401): Databricks proxy identity is required",
    );
  });

  test("rejects successful responses that are not QueryResult payloads", async () => {
    const database = new RemoteQueryable({
      baseUrl: "https://example.test",
      getAccessToken: async () => "access-token",
      fetch: async () =>
        new Response(JSON.stringify({ rows: [], rowCount: 1.5 }), {
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(database.query("SELECT 1")).rejects.toThrow(
      "Trusted SQL response is invalid",
    );
  });
});

describe("adaptPgPool", () => {
  test("preserves the Queryable repository seam and normalizes nullable row counts", async () => {
    const receivedValues: unknown[][] = [];
    const pool = {
      async query<T extends Record<string, unknown>>(
        text: string,
        values: unknown[] = [],
      ) {
        receivedValues.push(values);
        if (text === "SELECT body FROM note ORDER BY body") {
          return {
            rows: [{ body: "Pool repository" }] as unknown as T[],
            rowCount: null,
          };
        }
        return { rows: [] as T[], rowCount: null };
      },
    };
    const database: Queryable = adaptPgPool(pool);
    const readonlyValues: readonly PortableSqlValue[] = ["pending"];

    await expect(loadNoteBodies(database)).resolves.toEqual(["Pool repository"]);
    await expect(database.query("SELECT $1::text", readonlyValues)).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    expect(receivedValues[1]).toEqual(["pending"]);
    expect(receivedValues[1]).not.toBe(readonlyValues);
  });
});

describe("portable Queryable result contract", () => {
  test("normalizes timestamp, int8, and bytea-like rows identically while preserving pg rowCount", async () => {
    const query =
      "SELECT $1::timestamptz AS occurred_at, $2::bigint AS large_id, decode($3::text, 'base64') AS payload";
    const values = [
      "2026-08-13T10:00:00.000Z",
      "9007199254740993",
      "AQID",
    ] as const;
    const expectedRows = [
      {
        occurred_at: "2026-08-13T10:00:00.000Z",
        large_id: "9007199254740993",
        payload: "AQID",
      },
    ];
    const remote = new RemoteQueryable({
      baseUrl: await startTrustedSqlServer(),
      getAccessToken: async () => "service-token",
    });
    const pg = adaptPgPool({
      async query<T extends Record<string, unknown>>() {
        return {
          rows: [
            {
              occurred_at: new Date("2026-08-13T10:00:00.000Z"),
              large_id: 9_007_199_254_740_993n,
              payload: new Uint8Array([1, 2, 3]),
            },
          ] as unknown as T[],
          rowCount: 7,
        };
      },
    });

    const remoteResult = await remote.query(query, values);
    const pgResult = await pg.query(query, values);

    expect(remoteResult).toEqual({ rows: expectedRows, rowCount: 1 });
    expect(pgResult).toEqual({ rows: expectedRows, rowCount: 7 });
  });
});
