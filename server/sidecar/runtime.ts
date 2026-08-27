import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { LocalSnapshotStore } from "../snapshots/local-store.js";
import { SnapshotService } from "../snapshots/service.js";
import type { SnapshotStore } from "../snapshots/types.js";
import { createWorkspaceSnapshotStore } from "../snapshots/workspace-volume.js";
import { CheckpointCoordinator } from "./checkpoint-coordinator.js";
import type { SidecarConfig } from "./config.js";
import {
  SidecarExecutionBarrier,
  createSocketDatabaseAdapter,
} from "./execution-barrier.js";

export class DurableSidecarRuntime {
  readonly #barrier = new SidecarExecutionBarrier();
  #database: PGlite | undefined;
  #snapshots: SnapshotService | undefined;
  #coordinator: CheckpointCoordinator | undefined;
  #socket: PGLiteSocketServer | undefined;

  constructor(private readonly config: SidecarConfig) {}

  get database(): PGlite {
    if (!this.#database) throw new Error("PGlite sidecar is not started");
    return this.#database;
  }

  async start(): Promise<void> {
    if (this.#database) throw new Error("PGlite sidecar is already started");
    const store = this.snapshotStore();
    this.#snapshots = new SnapshotService({
      store,
      mode: this.config.snapshotMode,
      retention: this.config.snapshotRetention,
      dump: () => this.dumpDatabase(),
    });
    const reusingLocalDatabase = await localDatabaseExists(this.config.dataDir);
    const restored = reusingLocalDatabase
      ? null
      : await this.#snapshots.restoreLatest();
    await mkdir(this.config.dataDir, { recursive: true });
    this.#database = await PGlite.create({
      dataDir: this.config.dataDir,
      ...(restored
        ? { loadDataDir: new Blob([new Uint8Array(restored)]) }
        : {}),
    });
    if (reusingLocalDatabase) this.#snapshots.markDirty();

    this.#coordinator = new CheckpointCoordinator(
      this.#database,
      this.#snapshots,
      this.#barrier,
    );
    const socketDatabase = createSocketDatabaseAdapter(
      this.#database,
      this.#barrier,
    );
    this.#socket = new PGLiteSocketServer({
      db: socketDatabase,
      host: this.config.socketHost,
      port: this.config.socketPort,
      maxConnections: this.config.maxConnections,
    });
    await this.#socket.start();
    await this.#coordinator.captureWritesAndCheckpoint();
  }

  checkpoint(): Promise<boolean> {
    if (!this.#coordinator) {
      throw new Error("PGlite sidecar is not started");
    }
    return this.#coordinator.captureWritesAndCheckpoint();
  }

  async stopSocket(): Promise<void> {
    if (!this.#socket) return;
    const socket = this.#socket;
    this.#socket = undefined;
    await socket.stop();
  }

  async closeDatabase(): Promise<void> {
    if (!this.#database) return;
    const database = this.#database;
    this.#database = undefined;
    this.#coordinator = undefined;
    await database.close();
  }

  private snapshotStore(): SnapshotStore {
    if (this.config.snapshotMode === "filesystem") {
      return new LocalSnapshotStore(this.config.snapshotDirectory);
    }
    if (!this.config.volumeRoot) {
      throw new Error("AppKit snapshot mode requires a Volume root");
    }
    return createWorkspaceSnapshotStore(this.config.volumeRoot);
  }

  private async dumpDatabase(): Promise<Buffer> {
    const archive = await this.database.dumpDataDir("gzip");
    return Buffer.from(await archive.arrayBuffer());
  }
}

async function localDatabaseExists(dataDir: string): Promise<boolean> {
  try {
    await access(join(dataDir, "PG_VERSION"));
    return true;
  } catch {
    return false;
  }
}
