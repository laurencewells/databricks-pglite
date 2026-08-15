import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  snapshotPortableSqlParameters,
  type PortableSqlValue,
  type Queryable,
  type QueryResult,
} from "../shared/queryable.js";
import { AsyncMutex } from "./async-mutex.js";

interface NoteRow {
  id: string;
  body: string;
  created_by: string;
  created_at: string;
}

export interface Note {
  id: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface DatabaseOptions {
  dataDir: string;
  loadArchive?: Buffer;
  onWrite?: () => void;
}

export interface ReadOnlyDatabase {
  read<T extends Record<string, unknown>>(
    text: string,
    values?: readonly PortableSqlValue[],
  ): Promise<QueryResult<T>>;
}

export class DatabaseService implements Queryable {
  readonly #mutex = new AsyncMutex();

  private constructor(
    private readonly database: PGlite,
    private readonly onWrite: () => void,
  ) {}

  static async create(options: DatabaseOptions): Promise<DatabaseService> {
    await mkdir(options.dataDir, { recursive: true });
    const database = await PGlite.create({
      dataDir: options.dataDir,
      ...(options.loadArchive
        ? { loadDataDir: new Blob([new Uint8Array(options.loadArchive)]) }
        : {}),
    });
    const service = new DatabaseService(database, options.onWrite ?? (() => {}));
    await database.exec(`
      CREATE TABLE IF NOT EXISTS note (
        id text PRIMARY KEY,
        body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
        created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    return service;
  }

  async listNotes(): Promise<Note[]> {
    return this.#mutex.runExclusive(async () => {
      const result = await this.database.query<NoteRow>(`
        SELECT id, body, created_by, created_at::text AS created_at
        FROM note
        ORDER BY created_at DESC, id DESC
      `);
      return result.rows.map(mapNote);
    });
  }

  async addNote(body: string, createdBy: string): Promise<Note> {
    return this.#mutex.runExclusive(async () => {
      const result = await this.database.query<NoteRow>(
        `
          INSERT INTO note (id, body, created_by)
          VALUES ($1, $2, $3)
          RETURNING id, body, created_by, created_at::text AS created_at
        `,
        [randomUUID(), body, createdBy],
      );
      this.onWrite();
      return mapNote(result.rows[0]);
    });
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly PortableSqlValue[] = [],
  ): Promise<QueryResult<T>> {
    const portableValues = snapshotPortableSqlParameters(values);
    return this.#mutex.runExclusive(async () => {
      try {
        const result = await this.database.transaction(async (transaction) => {
          await transaction.exec("SET TRANSACTION READ ONLY");
          return transaction.query<T>(text, portableValues);
        });
        return toQueryResult(result);
      } catch (error) {
        if (!isReadOnlyTransactionError(error)) throw error;
      }

      const result = await this.database.query<T>(text, portableValues);
      this.onWrite();
      return toQueryResult(result);
    });
  }

  async read<T extends Record<string, unknown>>(
    text: string,
    values: readonly PortableSqlValue[] = [],
  ): Promise<QueryResult<T>> {
    const portableValues = snapshotPortableSqlParameters(values);
    return this.#mutex.runExclusive(async () => {
      const result = await this.database.query<T>(text, portableValues);
      return toQueryResult(result);
    });
  }

  async readTransaction<T>(
    operation: (database: ReadOnlyDatabase) => Promise<T>,
  ): Promise<T> {
    return this.#mutex.runExclusive(async () =>
      this.database.transaction(async (transaction) => {
        await transaction.exec(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return operation({
          read: async <TRow extends Record<string, unknown>>(
            text: string,
            values: readonly PortableSqlValue[] = [],
          ): Promise<QueryResult<TRow>> => {
            const portableValues = snapshotPortableSqlParameters(values);
            return toQueryResult(
              await transaction.query<TRow>(text, portableValues),
            );
          },
        });
      }),
    );
  }

  async dump(): Promise<Buffer> {
    return this.#mutex.runExclusive(async () => {
      const archive = await this.database.dumpDataDir("gzip");
      return Buffer.from(await archive.arrayBuffer());
    });
  }

  async close(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      await this.database.close();
    });
  }
}

function toQueryResult<T extends Record<string, unknown>>(result: {
  rows: T[];
  affectedRows?: number;
}): QueryResult<T> {
  return {
    rows: result.rows,
    rowCount: result.affectedRows || result.rows.length,
  };
}

function isReadOnlyTransactionError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "25006"
  );
}

function mapNote(row: NoteRow | undefined): Note {
  if (!row) throw new Error("Database did not return the inserted note");
  return {
    id: row.id,
    body: row.body,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
