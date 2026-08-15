import {
  toPortableSqlRow,
  type PortableSqlValue,
} from "../shared/queryable.js";
import type { DatabaseService } from "./database.js";

export interface DatabaseCatalog {
  database: string;
  schemas: Array<{ name: string; tables: string[] }>;
}

export interface BrowserRowsInput {
  schema: string;
  table: string;
  limit: number;
  offset: number;
}

export interface BrowserRowsPage {
  schema: string;
  table: string;
  columns: string[];
  rows: Array<Record<string, PortableSqlValue>>;
  totalRows: number;
  limit: number;
  offset: number;
}

type ReadDatabase = Pick<DatabaseService, "read" | "readTransaction">;

export class BrowserTableNotFoundError extends Error {
  constructor() {
    super("Database table was not found");
    this.name = "BrowserTableNotFoundError";
  }
}

export class DatabaseBrowser {
  constructor(private readonly database: ReadDatabase) {}

  async catalog(): Promise<DatabaseCatalog> {
    const databaseResult = await this.database.read<{ database_name: string }>(
      "SELECT current_database() AS database_name",
    );
    const database = databaseResult.rows[0]?.database_name;
    if (typeof database !== "string" || database.length === 0) {
      throw new Error("Database did not return a database name");
    }

    const result = await this.database.read<{
      schema_name: string;
      table_name: string | null;
    }>(`
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS table_name
      FROM pg_catalog.pg_namespace AS namespace
      LEFT JOIN pg_catalog.pg_class AS relation
        ON relation.relnamespace = namespace.oid
        AND relation.relkind IN ('r', 'p')
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY namespace.nspname, relation.relname
    `);

    const schemas = new Map<string, string[]>();
    for (const row of result.rows) {
      const tables = schemas.get(row.schema_name) ?? [];
      if (row.table_name !== null) tables.push(row.table_name);
      schemas.set(row.schema_name, tables);
    }

    return {
      database,
      schemas: [...schemas].map(([name, tables]) => ({ name, tables })),
    };
  }

  async rows(input: BrowserRowsInput): Promise<BrowserRowsPage> {
    validatePagination(input);
    return this.database.readTransaction(async (database) => {
      const primaryKeyResult = await database.read<{
        primary_key_columns: unknown;
      }>(
        `
          SELECT COALESCE(
            (
              SELECT array_agg(attribute.attname ORDER BY key_columns.ordinality)
              FROM pg_catalog.pg_index AS index
              JOIN unnest(index.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
                ON true
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = index.indrelid
                AND attribute.attnum = key_columns.attnum
              WHERE index.indrelid = relation.oid
                AND index.indisprimary
            ),
            ARRAY[]::text[]
          ) AS primary_key_columns
          FROM pg_catalog.pg_namespace AS namespace
          JOIN pg_catalog.pg_class AS relation
            ON relation.relnamespace = namespace.oid
          WHERE namespace.nspname = $1
            AND relation.relname = $2
            AND relation.relkind IN ('r', 'p')
            AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
            AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        `,
        [input.schema, input.table],
      );
      const primaryKeyColumns = primaryKeyResult.rows[0]?.primary_key_columns;
      if (primaryKeyColumns === undefined) throw new BrowserTableNotFoundError();

      const columnsResult = await database.read<{ column_name: string }>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `,
        [input.schema, input.table],
      );
      const schema = quoteIdentifier(input.schema);
      const table = quoteIdentifier(input.table);
      const countResult = await database.read<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM ${schema}.${table}`,
      );
      const rowsResult = await database.read<Record<string, unknown>>(
        `SELECT * FROM ${schema}.${table} ORDER BY ${pageOrderBy(primaryKeyColumns)} LIMIT $1 OFFSET $2`,
        [input.limit, input.offset],
      );

      return {
        schema: input.schema,
        table: input.table,
        columns: columnsResult.rows.map((row) => row.column_name),
        rows: rowsResult.rows.map(toPortableSqlRow),
        totalRows: parseTotalRows(countResult.rows[0]?.total),
        limit: input.limit,
        offset: input.offset,
      };
    });
  }
}

function pageOrderBy(primaryKeyColumns: unknown): string {
  if (!Array.isArray(primaryKeyColumns)) {
    throw new Error("Database returned invalid primary key metadata");
  }
  if (!primaryKeyColumns.every((column) => typeof column === "string")) {
    throw new Error("Database returned invalid primary key metadata");
  }
  if (primaryKeyColumns.length === 0) return "tableoid, ctid";
  return primaryKeyColumns.map(quoteIdentifier).join(", ");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseTotalRows(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Database returned an invalid row count");
  }
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Database returned an invalid row count");
  }
  return total;
}

function validatePagination(input: BrowserRowsInput): void {
  if (!Number.isSafeInteger(input.limit) || !Number.isSafeInteger(input.offset)) {
    throw new Error("Browser pagination values must be safe integers");
  }
  if (input.limit < 1 || input.limit > 100) {
    throw new Error("Browser page limit must be a safe integer between 1 and 100");
  }
  if (input.offset < 0) {
    throw new Error("Browser page offset must be a non-negative safe integer");
  }
}
