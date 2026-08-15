import { randomUUID } from "node:crypto";
import {
  createSnapshotManifest,
  parseSnapshotManifest,
  type SnapshotManifest,
  verifySnapshot,
} from "./manifest.js";
import type { SnapshotStore } from "./types.js";

const LATEST_POINTER = "latest.json";

export interface SnapshotStatus {
  mode: string;
  pendingWrites: number;
  checkpointing: boolean;
  lastCheckpointAt: string | null;
  lastArchive: string | null;
  restoredFrom: string | null;
}

export interface SnapshotServiceOptions {
  store: SnapshotStore;
  dump: () => Promise<Buffer>;
  mode?: string;
  retention?: number;
  clock?: () => Date;
  createId?: () => string;
  onCleanupError?: (error: unknown, path: string) => void;
}

export class SnapshotService {
  readonly #store: SnapshotStore;
  readonly #dump: () => Promise<Buffer>;
  readonly #mode: string;
  readonly #retention: number;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #onCleanupError: (error: unknown, path: string) => void;
  #pendingWrites = 0;
  #checkpointing = false;
  #inFlightCheckpoint: Promise<SnapshotManifest> | null = null;
  #lastCheckpointAt: string | null = null;
  #lastArchive: string | null = null;
  #restoredFrom: string | null = null;

  constructor(options: SnapshotServiceOptions) {
    this.#store = options.store;
    this.#dump = options.dump;
    this.#mode = options.mode ?? "filesystem";
    this.#retention = Math.max(1, options.retention ?? 3);
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#onCleanupError =
      options.onCleanupError ??
      ((error, path) =>
        console.error(`Snapshot retention cleanup failed for ${path}`, error));
  }

  markDirty(): void {
    this.#pendingWrites += 1;
  }

  status(): SnapshotStatus {
    return {
      mode: this.#mode,
      pendingWrites: this.#pendingWrites,
      checkpointing: this.#checkpointing,
      lastCheckpointAt: this.#lastCheckpointAt,
      lastArchive: this.#lastArchive,
      restoredFrom: this.#restoredFrom,
    };
  }

  async restoreLatest(): Promise<Buffer | null> {
    if (!(await this.#store.exists(LATEST_POINTER))) return null;
    const manifest = parseSnapshotManifest(
      await this.#store.readText(LATEST_POINTER),
    );
    const archive = await this.#store.readBytes(manifest.archive);
    if (!verifySnapshot(manifest, archive)) {
      throw new Error(
        `Snapshot checksum verification failed for ${manifest.archive}`,
      );
    }
    this.#lastCheckpointAt = manifest.createdAt;
    this.#lastArchive = manifest.archive;
    this.#restoredFrom = manifest.archive;
    return archive;
  }

  checkpoint(): Promise<SnapshotManifest> {
    if (this.#inFlightCheckpoint) return this.#inFlightCheckpoint;

    this.#checkpointing = true;
    const checkpoint = this.#createCheckpoint();
    this.#inFlightCheckpoint = checkpoint;
    void checkpoint.then(
      () => this.#clearInFlightCheckpoint(),
      () => this.#clearInFlightCheckpoint(),
    );
    return checkpoint;
  }

  async #createCheckpoint(): Promise<SnapshotManifest> {
    const previous = await this.#readCurrentManifest();
    const coveredWrites = this.#pendingWrites;
    const contents = await this.#dump();
    const createdAt = this.#clock().toISOString();
    const archive = `snapshots/${createdAt.replaceAll(":", "-").replace(".", "-")}-${this.#createId()}.tar.gz`;
    const previousArchives = previous
      ? [previous.archive, ...previous.retainedArchives]
      : [];
    const retainedArchives = previousArchives.slice(0, this.#retention - 1);
    const staleArchives = previousArchives.slice(this.#retention - 1);
    const manifest = createSnapshotManifest({
      archive,
      contents,
      createdAt,
      retainedArchives,
    });

    await this.#store.write(archive, contents);
    await this.#store.write(
      LATEST_POINTER,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    this.#pendingWrites = Math.max(0, this.#pendingWrites - coveredWrites);
    this.#lastCheckpointAt = createdAt;
    this.#lastArchive = archive;
    await Promise.all(
      staleArchives.map(async (path) => {
        try {
          await this.#store.delete(path);
        } catch (error) {
          this.#onCleanupError(error, path);
        }
      }),
    );
    return manifest;
  }

  #clearInFlightCheckpoint(): void {
    this.#inFlightCheckpoint = null;
    this.#checkpointing = false;
  }

  async #readCurrentManifest(): Promise<SnapshotManifest | null> {
    if (!(await this.#store.exists(LATEST_POINTER))) return null;
    return parseSnapshotManifest(await this.#store.readText(LATEST_POINTER));
  }
}
