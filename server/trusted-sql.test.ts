import express from "express";
import request from "supertest";
import { describe, expect, test } from "vitest";
import { toPortableSqlValue } from "../shared/queryable.js";
import { MutationDrain } from "./mutation-drain.js";
import { registerTrustedSqlRoute } from "./trusted-sql.js";

const identityHeaders = {
  "x-forwarded-user": "user-123",
  "x-forwarded-preferred-username": "alice@example.com",
};

function testApplication(
  onQuery: (text: string, values: readonly unknown[]) => void,
) {
  const app = express();
  app.use(express.json());
  registerTrustedSqlRoute(app, {
    environment: "production",
    database: {
      async query<T extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        onQuery(text, values);
        return { rows: [] as T[], rowCount: 0 };
      },
    },
    mutations: new MutationDrain(),
  });
  return app;
}

describe("trusted SQL request validation", () => {
  test("rejects blank and oversized SQL text", async () => {
    const app = testApplication(() => {
      throw new Error("invalid SQL reached the database");
    });

    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "   ", values: [] })
      .expect(400, { error: "Invalid SQL query request" });
    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "x".repeat(8_193), values: [] })
      .expect(400, { error: "Invalid SQL query request" });
  });

  test("defaults missing values to an empty array", async () => {
    let receivedValues: readonly unknown[] | undefined;
    const app = testApplication((_text, values) => {
      receivedValues = values;
    });

    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "SELECT 1" })
      .expect(200);

    expect(receivedValues).toEqual([]);
  });

  test("rejects non-array values and unknown request fields", async () => {
    const app = testApplication(() => {
      throw new Error("invalid SQL reached the database");
    });

    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "SELECT 1", values: "not-an-array" })
      .expect(400, { error: "Invalid SQL query request" });
    await request(app)
      .post("/api/v1/sql/query")
      .set(identityHeaders)
      .send({ text: "SELECT 1", values: [], authorization: "secret" })
      .expect(400, { error: "Invalid SQL query request" });
  });
});

describe("trusted SQL JSON encoding", () => {
  test("encodes bigint, binary, and dates with portable JSON values", () => {
    expect(toPortableSqlValue(9_007_199_254_740_993n)).toBe("9007199254740993");
    expect(toPortableSqlValue(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(toPortableSqlValue(new Date("2026-08-13T10:00:00.000Z"))).toBe(
      "2026-08-13T10:00:00.000Z",
    );
    expect(toPortableSqlValue(Number.NaN)).toBe("NaN");
    expect(toPortableSqlValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(toPortableSqlValue(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
  });

  test("recursively encodes nested arrays and plain row objects", () => {
    expect(
      toPortableSqlValue({
        id: 7,
        metadata: {
          active: true,
          values: [1n, null, new Uint8Array([255])],
        },
      }),
    ).toEqual({
      id: 7,
      metadata: {
        active: true,
        values: ["1", null, "/w=="],
      },
    });
  });
});
