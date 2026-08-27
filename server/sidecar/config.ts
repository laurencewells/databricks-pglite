import type { SnapshotMode } from "../config.js";

export interface SidecarConfig {
  child: [string, ...string[]];
  dataDir: string;
  socketHost: "127.0.0.1";
  socketPort: number;
  maxConnections: number;
  snapshotMode: SnapshotMode;
  snapshotDirectory: string;
  volumeRoot?: string;
  snapshotIntervalMs: number;
  snapshotRetention: number;
  shutdownTimeoutMs: number;
}

export function loadSidecarConfig(
  environment: Record<string, string | undefined>,
  arguments_: string[],
): SidecarConfig {
  if (arguments_[0] !== "--" || !arguments_[1]) {
    throw new Error("sidecar command must be provided after --");
  }
  const socketHost = environment.PGLITE_SOCKET_HOST ?? "127.0.0.1";
  if (socketHost !== "127.0.0.1") {
    throw new Error("PGLITE_SOCKET_HOST must be 127.0.0.1");
  }
  const snapshotMode = environment.SNAPSHOT_MODE ?? "filesystem";
  if (snapshotMode !== "filesystem" && snapshotMode !== "appkit") {
    throw new Error("SNAPSHOT_MODE must be filesystem or appkit");
  }
  const volumeRoot = environment.DATABRICKS_VOLUME_FILES;
  if (snapshotMode === "appkit" && !volumeRoot?.startsWith("/Volumes/")) {
    throw new Error(
      "DATABRICKS_VOLUME_FILES must be an absolute /Volumes path in AppKit mode",
    );
  }

  return {
    child: arguments_.slice(1) as [string, ...string[]],
    dataDir: environment.PGLITE_DATA_DIR ?? ".data/pglite",
    socketHost,
    socketPort: networkPort(environment.PGLITE_SOCKET_PORT),
    maxConnections: positiveInteger(
      environment.PGLITE_SOCKET_MAX_CONNECTIONS,
      1,
      "PGLITE_SOCKET_MAX_CONNECTIONS",
    ),
    snapshotMode,
    snapshotDirectory:
      environment.SNAPSHOT_DIRECTORY ?? ".data/snapshots",
    ...(volumeRoot ? { volumeRoot } : {}),
    snapshotIntervalMs: positiveInteger(
      environment.SNAPSHOT_INTERVAL_MS,
      30_000,
      "SNAPSHOT_INTERVAL_MS",
    ),
    snapshotRetention: positiveInteger(
      environment.SNAPSHOT_RETENTION,
      3,
      "SNAPSHOT_RETENTION",
    ),
    shutdownTimeoutMs: positiveInteger(
      environment.SIDECAR_SHUTDOWN_TIMEOUT_MS,
      10_000,
      "SIDECAR_SHUTDOWN_TIMEOUT_MS",
    ),
  };
}

function networkPort(raw: string | undefined): number {
  const value = raw === undefined ? 5432 : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PGLITE_SOCKET_PORT must be an integer between 1 and 65535");
  }
  return value;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
