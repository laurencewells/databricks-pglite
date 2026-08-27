import { describe, expect, test } from "vitest";
import { loadSidecarConfig } from "./config.js";

const baseEnvironment = {
  SNAPSHOT_MODE: "filesystem",
  SNAPSHOT_DIRECTORY: ".data/snapshots",
};

describe("loadSidecarConfig", () => {
  test("preserves the exact child argument vector after the separator", () => {
    const config = loadSidecarConfig(baseEnvironment, [
      "--",
      "uv",
      "run",
      "uvicorn",
      "app:app",
      "--port",
      "8000",
    ]);

    expect(config.child).toEqual([
      "uv",
      "run",
      "uvicorn",
      "app:app",
      "--port",
      "8000",
    ]);
    expect(config).toMatchObject({
      socketHost: "127.0.0.1",
      socketPort: 5432,
      maxConnections: 1,
      snapshotIntervalMs: 30_000,
      snapshotRetention: 3,
      shutdownTimeoutMs: 10_000,
    });
  });

  test.each(["0.0.0.0", "::", "localhost", "192.168.1.2"])(
    "rejects non-literal-loopback host %s",
    (socketHost) => {
      expect(() =>
        loadSidecarConfig(
          { ...baseEnvironment, PGLITE_SOCKET_HOST: socketHost },
          ["--", "uv"],
        ),
      ).toThrow("PGLITE_SOCKET_HOST must be 127.0.0.1");
    },
  );

  test("requires an exact separator followed by a child executable", () => {
    expect(() => loadSidecarConfig(baseEnvironment, ["uv", "run"])).toThrow(
      "sidecar command must be provided after --",
    );
    expect(() => loadSidecarConfig(baseEnvironment, ["--"])).toThrow(
      "sidecar command must be provided after --",
    );
  });

  test("requires an absolute Unity Catalog Volume in AppKit mode", () => {
    expect(() =>
      loadSidecarConfig({ SNAPSHOT_MODE: "appkit" }, ["--", "uv"]),
    ).toThrow(
      "DATABRICKS_VOLUME_FILES must be an absolute /Volumes path in AppKit mode",
    );
  });

  test.each([
    ["PGLITE_SOCKET_PORT", "0"],
    ["PGLITE_SOCKET_PORT", "65536"],
    ["PGLITE_SOCKET_MAX_CONNECTIONS", "0"],
    ["SIDECAR_SHUTDOWN_TIMEOUT_MS", "-1"],
  ])("rejects invalid numeric setting %s=%s", (name, value) => {
    expect(() =>
      loadSidecarConfig({ ...baseEnvironment, [name]: value }, ["--", "uv"]),
    ).toThrow(name);
  });
});
