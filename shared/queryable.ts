export interface QueryResult<T extends Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export type PortableSqlValue =
  | boolean
  | null
  | number
  | string
  | readonly PortableSqlValue[]
  | { readonly [key: string]: PortableSqlValue };

export interface Queryable {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly PortableSqlValue[],
  ): Promise<QueryResult<T>>;
}

/**
 * Deeply snapshot the JSON-portable subset and reject values whose meaning
 * JSON would lose. The snapshot protects asynchronous adapters from caller
 * mutation and JavaScript callers that do not consume the TypeScript contract.
 */
export function snapshotPortableSqlParameters(
  values: readonly unknown[],
): PortableSqlValue[] {
  if (!Array.isArray(values)) {
    throw new TypeError(
      "SQL parameters must be an array of portable values; pass [] when the query has no parameters.",
    );
  }
  const snapshot: PortableSqlValue[] = [];
  for (let index = 0; index < values.length; index += 1) {
    snapshot.push(
      snapshotPortableSqlValue(
        values[index],
        `values[${index}]`,
        `$${index + 1}`,
        new WeakSet(),
      ),
    );
  }
  return snapshot;
}

/** Normalize driver-native PostgreSQL values to the shared JSON result shape. */
export function normalizeQueryResult<T extends Record<string, unknown>>(
  result: {
    rows: readonly Record<string, unknown>[];
    rowCount: number;
  },
): QueryResult<T> {
  return {
    rows: result.rows.map(toPortableSqlRow) as T[],
    rowCount: result.rowCount,
  };
}

export function toPortableSqlValue(value: unknown): PortableSqlValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : value.toString();
  }
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return base64(value);
  if (Array.isArray(value)) return value.map(toPortableSqlValue);
  if (isPlainObject(value)) return toPortableSqlRow(value);
  throw new TypeError(
    "SQL result contains a value that cannot be encoded as portable JSON",
  );
}

export function toPortableSqlRow(
  value: Record<string, unknown>,
): { [key: string]: PortableSqlValue } {
  if (!isPlainObject(value)) {
    throw new TypeError("SQL result row must be a plain object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      toPortableSqlValue(item),
    ]),
  );
}

function snapshotPortableSqlValue(
  value: unknown,
  path: string,
  placeholder: string,
  ancestors: WeakSet<object>,
): PortableSqlValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(
      `SQL parameter ${path} is not portable: use a finite number, or send "NaN", "Infinity", or "-Infinity" as a string and cast ${placeholder}::double precision in SQL.`,
    );
  }
  if (typeof value === "bigint") {
    throw new TypeError(
      `SQL parameter ${path} is not portable: use a decimal string and cast ${placeholder}::bigint or ${placeholder}::numeric in SQL.`,
    );
  }
  if (typeof value === "undefined") {
    throw new TypeError(
      `SQL parameter ${path} is not portable: use null instead of undefined.`,
    );
  }
  if (value instanceof Date) {
    throw new TypeError(
      `SQL parameter ${path} is not portable: use an ISO string and cast ${placeholder}::timestamptz in SQL.`,
    );
  }
  if (value instanceof Uint8Array) {
    throw new TypeError(
      `SQL parameter ${path} is not portable: use a base64 string and decode(${placeholder}, 'base64') in SQL.`,
    );
  }
  if (Array.isArray(value)) {
    assertNotCircular(value, path, ancestors);
    try {
      const snapshot: PortableSqlValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        snapshot.push(
          snapshotPortableSqlValue(
            value[index],
            `${path}[${index}]`,
            placeholder,
            ancestors,
          ),
        );
      }
      return snapshot;
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainObject(value)) {
    assertNotCircular(value, path, ancestors);
    try {
      const snapshot = Object.create(null) as Record<
        string,
        PortableSqlValue
      >;
      for (const [key, item] of Object.entries(value)) {
        snapshot[key] = snapshotPortableSqlValue(
          item,
          `${path}.${key}`,
          placeholder,
          ancestors,
        );
      }
      return snapshot;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError(
    `SQL parameter ${path} is not portable: use only null, booleans, finite numbers, strings, arrays, and plain objects. Convert bigint to a decimal string with an explicit SQL cast, Date to an ISO string with an explicit SQL cast, and binary data to a base64 string with decode(${placeholder}, 'base64').`,
  );
}

function assertNotCircular(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (ancestors.has(value)) {
    throw new TypeError(
      `SQL parameter ${path} is not portable: circular values are unsupported.`,
    );
  }
  ancestors.add(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function base64(value: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index] ?? 0;
    const second = value[index + 1];
    const third = value[index + 2];
    const bits = first << 16 | (second ?? 0) << 8 | (third ?? 0);
    encoded += alphabet[(bits >> 18) & 63];
    encoded += alphabet[(bits >> 12) & 63];
    encoded += second === undefined ? "=" : alphabet[(bits >> 6) & 63];
    encoded += third === undefined ? "=" : alphabet[bits & 63];
  }
  return encoded;
}
