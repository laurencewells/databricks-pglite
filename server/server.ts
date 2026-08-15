import { access } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";
import {
  createApp,
  files,
  server,
  type FilePolicy,
} from "@databricks/appkit";
import express from "express";
import type { ViteDevServer } from "vite";
import { loadConfig } from "./config.js";
import { DatabaseBrowser } from "./database-browser.js";
import { DatabaseService } from "./database.js";
import { durabilityLifecycle } from "./durability-lifecycle.js";
import { checkpointAndCloseDatabase } from "./durability-shutdown.js";
import { MutationDrain } from "./mutation-drain.js";
import { registerRoutes } from "./routes.js";
import {
  AppKitSnapshotStore,
  type SnapshotVolume,
} from "./snapshots/appkit-store.js";
import { LocalSnapshotStore } from "./snapshots/local-store.js";
import { SnapshotService } from "./snapshots/service.js";
import type { SnapshotStore } from "./snapshots/types.js";

const config = loadConfig(process.env);
const internalSnapshotsOnly: FilePolicy = (_action, _resource, user) =>
  user.isServicePrincipal === true;

let database: DatabaseService | undefined;
let browser: DatabaseBrowser | undefined;
let snapshots: SnapshotService | undefined;
let localServer: HttpServer | undefined;
let localVite: ViteDevServer | undefined;
let checkpointTimer: NodeJS.Timeout | undefined;
let shutdownStarted = false;
const mutations = new MutationDrain();

if (config.snapshotMode === "appkit") {
  await startDatabricksApp();
} else {
  await startLocalApp();
}

checkpointTimer = setInterval(() => {
  if (!snapshots || snapshots.status().pendingWrites === 0) return;
  void snapshots.checkpoint().catch((error: unknown) => {
    console.error("Automatic checkpoint failed", error);
  });
}, config.snapshotIntervalMs);
checkpointTimer.unref();

async function shutdownLocal(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (checkpointTimer) clearInterval(checkpointTimer);
  if (localServer) {
    await new Promise<void>((resolve, reject) =>
      localServer!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (localVite) await localVite.close();
  try {
    await shutdownDatabase();
  } catch (error) {
    console.error("Shutdown checkpoint failed", error);
  }
}

async function shutdownDatabase(): Promise<void> {
  if (checkpointTimer) clearInterval(checkpointTimer);
  await checkpointAndCloseDatabase({ database, mutations, snapshots });
}

if (config.snapshotMode === "filesystem") {
  process.once("SIGTERM", () => void shutdownLocal());
  process.once("SIGINT", () => void shutdownLocal());
}

async function localDatabaseExists(dataDir: string): Promise<boolean> {
  try {
    await access(join(dataDir, "PG_VERSION"));
    return true;
  } catch {
    return false;
  }
}

async function startDatabricksApp(): Promise<void> {
  await createApp({
    plugins: [
      server({ bodyLimit: "16kb" }),
      files({
        volumes: {
          files: {
            auth: "service-principal",
            policy: internalSnapshotsOnly,
          },
        },
      }),
      durabilityLifecycle({
        onShutdown: shutdownDatabase,
      }),
    ],
    async onPluginsReady(appkit) {
      await initialize(
        new AppKitSnapshotStore(
          appkit.files("files") as unknown as SnapshotVolume,
        ),
      );
      appkit.server.extend(registerApplicationRoutes);
    },
  });
}

async function startLocalApp(): Promise<void> {
  await initialize(new LocalSnapshotStore(config.snapshotDirectory));
  const application = express();
  registerApplicationRoutes(application);

  if (config.environment === "production") {
    const clientDirectory = join(process.cwd(), "client", "dist");
    application.use(express.static(clientDirectory, { index: false }));
    application.get("*", (_request, response) =>
      response.sendFile(join(clientDirectory, "index.html")),
    );
  } else {
    const { createServer: createViteServer } = await import("vite");
    localVite = await createViteServer({
      appType: "spa",
      configFile: join(process.cwd(), "client", "vite.config.ts"),
      root: join(process.cwd(), "client"),
      server: { middlewareMode: true },
    });
    application.use(localVite.middlewares);
  }

  const port = config.port;
  localServer = await new Promise<HttpServer>((resolve, reject) => {
    const listeningServer = application.listen(port, "0.0.0.0", () =>
      resolve(listeningServer),
    );
    listeningServer.once("error", reject);
  });
  console.log(`Local server listening on http://0.0.0.0:${port}`);
}

async function initialize(store: SnapshotStore): Promise<void> {
  snapshots = new SnapshotService({
    store,
    mode: config.snapshotMode,
    retention: config.snapshotRetention,
    dump: async () => {
      if (!database) throw new Error("Database is not initialized");
      return database.dump();
    },
  });

  const reusingLocalDatabase = await localDatabaseExists(config.dataDir);
  const loadArchive = reusingLocalDatabase
    ? null
    : await snapshots.restoreLatest();
  database = await DatabaseService.create({
    dataDir: config.dataDir,
    ...(loadArchive ? { loadArchive } : {}),
    onWrite: () => snapshots?.markDirty(),
  });
  browser = new DatabaseBrowser(database);
  if (reusingLocalDatabase) snapshots.markDirty();
}

function registerApplicationRoutes(application: express.Application): void {
  registerRoutes(application, {
    environment: config.environment,
    allowLocalIdentity: config.allowLocalIdentity,
    database: database!,
    browser: browser!,
    snapshots: snapshots!,
    mutations,
    webUiEnabled: config.webUiEnabled,
    checkpointIntervalMs: config.snapshotIntervalMs,
  });
}
