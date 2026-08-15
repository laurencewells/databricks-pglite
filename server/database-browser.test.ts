import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { PortableSqlValue, QueryResult } from "../shared/queryable.js";
import { DatabaseService } from "./database.js";
import {
  BrowserTableNotFoundError,
  DatabaseBrowser,
} from "./database-browser.js";

type ReadDatabase = Pick<DatabaseService, "read">;
type TransactionalReadDatabase = ReadDatabase & {
  readTransaction<T>(
    operation: (database: ReadDatabase) => Promise<T>,
  ): Promise<T>;
};

interface ReadCall {
  text: string;
  values: readonly PortableSqlValue[];
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pglite-browser-"));
  temporaryDirectories.push(directory);
  return directory;
}

function queuedReader(
  results: QueryResult<Record<string, unknown>>[],
): TransactionalReadDatabase & { calls: ReadCall[] } {
  const calls: ReadCall[] = [];
  const reader: TransactionalReadDatabase & { calls: ReadCall[] } = {
    calls,
    async read<T extends Record<string, unknown>>(
      text: string,
      values: readonly PortableSqlValue[] = [],
    ): Promise<QueryResult<T>> {
      calls.push({ text, values });
      const result = results.shift();
      if (!result) throw new Error("No queued query result");
      return result as QueryResult<T>;
    },
    async readTransaction<T>(
      operation: (database: ReadDatabase) => Promise<T>,
    ): Promise<T> {
      return operation(reader);
    },
  };
  return reader;
}

describe("DatabaseBrowser", () => {
  test("groups user schemas and tables into one catalog", async () => {
    const reader = queuedReader([
      { rows: [{ database_name: "postgres" }], rowCount: 1 },
      {
        rows: [
          { schema_name: "app", table_name: null },
          {
            schema_name: "public",
            table_name: "demo_customer",
          },
          {
            schema_name: "public",
            table_name: "note",
          },
        ],
        rowCount: 3,
      },
    ]);
    const browser = new DatabaseBrowser(reader);

    await expect(browser.catalog()).resolves.toEqual({
      database: "postgres",
      schemas: [
        { name: "app", tables: [] },
        { name: "public", tables: ["demo_customer", "note"] },
      ],
    });
    expect(reader.calls[1]?.text).toContain(
      "namespace.nspname NOT IN ('pg_catalog', 'information_schema')",
    );
    expect(reader.calls[1]?.text).toContain("namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'");
  });

  test("returns the connected database name when no user schemas are visible", async () => {
    const reader = queuedReader([
      { rows: [{ database_name: "postgres" }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const browser = new DatabaseBrowser(reader);

    await expect(browser.catalog()).resolves.toEqual({
      database: "postgres",
      schemas: [],
    });
  });

  test("validates and safely quotes a table before reading a page", async () => {
    const reader = queuedReader([
      {
        rows: [{ exists: true, primary_key_columns: ["value"] }],
        rowCount: 1,
      },
      { rows: [{ column_name: "value" }], rowCount: 1 },
      { rows: [{ total: "1" }], rowCount: 1 },
      { rows: [{ value: "safe" }], rowCount: 1 },
    ]);
    const browser = new DatabaseBrowser(reader);

    await expect(
      browser.rows({
        schema: 'odd"schema',
        table: "table name",
        limit: 50,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      columns: ["value"],
      rows: [{ value: "safe" }],
      totalRows: 1,
      limit: 50,
      offset: 0,
    });
    expect(reader.calls.at(-1)?.text).toContain(
      'FROM "odd""schema"."table name"',
    );
  });

  test("uses one locked snapshot and primary-key order for a page", async () => {
    const reader = queuedReader([
      {
        rows: [{ exists: true, primary_key_columns: ["id"] }],
        rowCount: 1,
      },
      { rows: [{ column_name: "id" }], rowCount: 1 },
      { rows: [{ total: "2" }], rowCount: 1 },
      { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 },
    ]);
    let transactions = 0;
    const readTransaction = reader.readTransaction.bind(reader);
    reader.readTransaction = async (operation) => {
      transactions += 1;
      return readTransaction(operation);
    };
    const browser = new DatabaseBrowser(reader);

    await expect(
      browser.rows({ schema: "public", table: "customer", limit: 2, offset: 0 }),
    ).resolves.toMatchObject({
      rows: [{ id: 1 }, { id: 2 }],
      totalRows: 2,
    });

    expect(transactions).toBe(1);
    expect(reader.calls.at(-1)?.text).toContain('ORDER BY "id"');
  });

  test("uses tableoid and ctid as the deterministic fallback for a keyless table", async () => {
    const reader = queuedReader([
      {
        rows: [{ exists: true, primary_key_columns: [] }],
        rowCount: 1,
      },
      { rows: [{ column_name: "value" }], rowCount: 1 },
      { rows: [{ total: "1" }], rowCount: 1 },
      { rows: [{ value: "stable" }], rowCount: 1 },
    ]);
    const browser = new DatabaseBrowser(reader);

    await browser.rows({ schema: "public", table: "keyless", limit: 1, offset: 0 });

    expect(reader.calls.at(-1)?.text).toContain("ORDER BY tableoid, ctid");
  });

  test("orders primary-key pages consistently across offsets", async () => {
    const database = await DatabaseService.create({
      dataDir: await temporaryDataDirectory(),
    });
    await database.query(
      "CREATE TABLE customer (id integer PRIMARY KEY, label text NOT NULL)",
    );
    await database.query(
      "INSERT INTO customer (id, label) VALUES (3, 'three'), (1, 'one'), (4, 'four'), (2, 'two')",
    );
    const browser = new DatabaseBrowser(database);

    const firstPage = await browser.rows({
      schema: "public",
      table: "customer",
      limit: 2,
      offset: 0,
    });
    const secondPage = await browser.rows({
      schema: "public",
      table: "customer",
      limit: 2,
      offset: 2,
    });
    await database.close();

    expect([...firstPage.rows, ...secondPage.rows].map((row) => row.id)).toEqual([
      1,
      2,
      3,
      4,
    ]);
    expect(firstPage.totalRows).toBe(4);
    expect(secondPage.totalRows).toBe(4);
  });

  test("rejects a page larger than 100 rows before querying the catalog", async () => {
    const reader = queuedReader([]);
    const browser = new DatabaseBrowser(reader);

    await expect(
      browser.rows({ schema: "public", table: "note", limit: 101, offset: 0 }),
    ).rejects.toThrow("Browser page limit must be a safe integer between 1 and 100");
    expect(reader.calls).toEqual([]);
  });

  test.each([
    {
      limit: 0,
      offset: 0,
      error: "Browser page limit must be a safe integer between 1 and 100",
    },
    {
      limit: 50.5,
      offset: 0,
      error: "Browser pagination values must be safe integers",
    },
    {
      limit: Number.MAX_SAFE_INTEGER + 1,
      offset: 0,
      error: "Browser pagination values must be safe integers",
    },
    {
      limit: 50,
      offset: -1,
      error: "Browser page offset must be a non-negative safe integer",
    },
    {
      limit: 50,
      offset: Number.POSITIVE_INFINITY,
      error: "Browser pagination values must be safe integers",
    },
  ])("rejects invalid or non-safe pagination: %o", async ({ limit, offset, error }) => {
    const reader = queuedReader([]);
    const browser = new DatabaseBrowser(reader);

    await expect(
      browser.rows({ schema: "public", table: "note", limit, offset }),
    ).rejects.toThrow(error);
    expect(reader.calls).toEqual([]);
  });

  test("rejects a table missing from the catalog", async () => {
    const browser = new DatabaseBrowser(
      queuedReader([{ rows: [], rowCount: 0 }]),
    );

    await expect(
      browser.rows({ schema: "public", table: "missing", limit: 50, offset: 0 }),
    ).rejects.toBeInstanceOf(BrowserTableNotFoundError);
  });
});
