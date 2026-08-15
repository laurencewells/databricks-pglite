import {
  normalizeQueryResult,
  snapshotPortableSqlParameters,
  type PortableSqlValue,
  type Queryable,
  type QueryResult,
} from "../shared/queryable.js";

export interface RemoteQueryableOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string> | string;
  fetch?: typeof globalThis.fetch;
}

export class RemoteQueryable implements Queryable {
  readonly #baseUrl: string;
  readonly #getAccessToken: () => Promise<string> | string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: RemoteQueryableOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly PortableSqlValue[] = [],
  ): Promise<QueryResult<T>> {
    const portableValues = snapshotPortableSqlParameters(values);
    const body = JSON.stringify({ text, values: portableValues });
    const token = await this.#getAccessToken();
    const response = await this.#fetch(`${this.#baseUrl}/api/v1/sql/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    const payload = await responsePayload(response);

    if (!response.ok) {
      throw new Error(
        `Trusted SQL request failed (${response.status}): ${safeErrorMessage(payload)}`,
      );
    }
    if (!isQueryResult(payload)) {
      throw new Error("Trusted SQL response is invalid");
    }
    try {
      return normalizeQueryResult<T>(payload);
    } catch {
      throw new Error("Trusted SQL response is invalid");
    }
  }
}

export interface PgLikeQueryResult<T extends Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface PgLikePool {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgLikeQueryResult<T>>;
}

/** Adapts pg.Pool's mutable parameters and nullable row count to Queryable. */
export function adaptPgPool(pool: PgLikePool): Queryable {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
      values: readonly PortableSqlValue[] = [],
    ): Promise<QueryResult<T>> {
      const portableValues = snapshotPortableSqlParameters(values);
      const result = await pool.query<T>(text, portableValues);
      return normalizeQueryResult<T>({
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      });
    },
  };
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function safeErrorMessage(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return "Request failed";
}

function isQueryResult(payload: unknown): payload is QueryResult<Record<string, unknown>> {
  return (
    !!payload &&
    typeof payload === "object" &&
    "rows" in payload &&
    Array.isArray(payload.rows) &&
    payload.rows.every(
      (row) => !!row && typeof row === "object" && !Array.isArray(row),
    ) &&
    "rowCount" in payload &&
    typeof payload.rowCount === "number" &&
    Number.isInteger(payload.rowCount)
  );
}
