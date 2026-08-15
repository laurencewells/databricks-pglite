export type SnapshotMode = "filesystem" | "appkit";

export interface AppConfig {
  environment: "development" | "test" | "production";
  dataDir: string;
  snapshotMode: SnapshotMode;
  snapshotDirectory: string;
  snapshotIntervalMs: number;
  snapshotRetention: number;
  allowLocalIdentity: boolean;
  port: number;
  webUiEnabled: boolean;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): AppConfig {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnvironment)) {
    throw new Error(`Unsupported NODE_ENV: ${nodeEnvironment}`);
  }
  const snapshotMode = environment.SNAPSHOT_MODE ?? "filesystem";
  if (snapshotMode !== "filesystem" && snapshotMode !== "appkit") {
    throw new Error(`Unsupported SNAPSHOT_MODE: ${snapshotMode}`);
  }
  const volumePath = environment.DATABRICKS_VOLUME_FILES;
  if (snapshotMode === "appkit" && !volumePath?.startsWith("/Volumes/")) {
    throw new Error(
      "DATABRICKS_VOLUME_FILES must be an absolute /Volumes path in AppKit mode",
    );
  }

  return {
    environment: nodeEnvironment as AppConfig["environment"],
    dataDir: environment.PGLITE_DATA_DIR ?? ".data/pglite",
    snapshotMode,
    snapshotDirectory: environment.SNAPSHOT_DIRECTORY ?? ".data/snapshots",
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
    allowLocalIdentity: environment.ALLOW_LOCAL_IDENTITY === "true",
    port: networkPort(
      environment.DATABRICKS_APP_PORT ?? environment.PORT,
      environment.DATABRICKS_APP_PORT === undefined
        ? "PORT"
        : "DATABRICKS_APP_PORT",
    ),
    webUiEnabled: booleanValue(
      environment.WEB_UI_ENABLED,
      true,
      "WEB_UI_ENABLED",
    ),
  };
}

function booleanValue(
  raw: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function networkPort(raw: string | undefined, name: string): number {
  if (raw === undefined) return 8000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
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
