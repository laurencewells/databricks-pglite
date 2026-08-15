import { describe, expect, test } from "vitest";
import { requestIdentity } from "./identity.js";

describe("requestIdentity", () => {
  test("uses the Databricks forwarded user identity in production", () => {
    expect(
      requestIdentity(
        {
          "x-forwarded-preferred-username": "alice@example.com",
          "x-forwarded-user": "12345",
        },
        "production",
      ),
    ).toEqual({ id: "12345", displayName: "alice@example.com" });
  });

  test("rejects a production request without trusted proxy identity", () => {
    expect(() => requestIdentity({}, "production")).toThrow(
      "Databricks proxy identity is required",
    );
  });

  test("uses an explicit local identity only in development", () => {
    expect(requestIdentity({}, "development")).toEqual({
      id: "local-developer",
      displayName: "Local developer",
    });
  });

  test("allows an explicit local-container identity without weakening production by default", () => {
    expect(requestIdentity({}, "production", true)).toEqual({
      id: "local-developer",
      displayName: "Local developer",
    });
    expect(() => requestIdentity({}, "production", false)).toThrow(
      "Databricks proxy identity is required",
    );
  });
});
