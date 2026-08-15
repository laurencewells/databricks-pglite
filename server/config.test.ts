import { describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  test("defaults local development to filesystem snapshots", () => {
    expect(loadConfig({ NODE_ENV: "development" })).toEqual({
      environment: "development",
      dataDir: ".data/pglite",
      snapshotMode: "filesystem",
      snapshotDirectory: ".data/snapshots",
      snapshotIntervalMs: 30_000,
      snapshotRetention: 3,
      allowLocalIdentity: false,
      port: 8000,
      webUiEnabled: true,
    });
  });

  test("accepts deployed AppKit Volume configuration", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        SNAPSHOT_MODE: "appkit",
        DATABRICKS_VOLUME_FILES: "/Volumes/demo/app/pglite_snapshots",
        PGLITE_DATA_DIR: "/tmp/pglite/data",
        SNAPSHOT_INTERVAL_MS: "60000",
        SNAPSHOT_RETENTION: "5",
        ALLOW_LOCAL_IDENTITY: "true",
      }),
    ).toMatchObject({
      environment: "production",
      snapshotMode: "appkit",
      dataDir: "/tmp/pglite/data",
      snapshotIntervalMs: 60_000,
      snapshotRetention: 5,
      allowLocalIdentity: true,
    });
  });

  test("rejects AppKit mode without a canonical Volume path", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        SNAPSHOT_MODE: "appkit",
        DATABRICKS_VOLUME_FILES: "snapshots",
      }),
    ).toThrow(
      "DATABRICKS_VOLUME_FILES must be an absolute /Volumes path",
    );
  });

  test("uses PORT locally and gives DATABRICKS_APP_PORT precedence", () => {
    expect(loadConfig({ PORT: "9000" }).port).toBe(9000);
    expect(
      loadConfig({ PORT: "9000", DATABRICKS_APP_PORT: "8001" }).port,
    ).toBe(8001);
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
  });

  test("defaults the web UI on and accepts an explicit false value", () => {
    expect(loadConfig({ NODE_ENV: "development" }).webUiEnabled).toBe(true);
    expect(
      loadConfig({ NODE_ENV: "development", WEB_UI_ENABLED: "false" })
        .webUiEnabled,
    ).toBe(false);
  });

  test("rejects ambiguous web UI values", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", WEB_UI_ENABLED: "0" }),
    ).toThrow("WEB_UI_ENABLED must be true or false");
  });
});
