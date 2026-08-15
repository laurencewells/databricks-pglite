import { describe, expect, test } from "vitest";
import { MutationDrain } from "./mutation-drain.js";
import { checkpointAndCloseDatabase } from "./durability-shutdown.js";
import { SnapshotService } from "./snapshots/service.js";
import type { SnapshotContents, SnapshotStore } from "./snapshots/types.js";

class GatedSnapshotStore implements SnapshotStore {
  readonly files = new Map<string, Buffer>();
  readonly firstArchiveWriteStarted: Promise<void>;
  #signalFirstArchiveWriteStarted!: () => void;
  #releaseFirstArchiveWrite!: () => void;
  #firstArchiveWrite = true;
  #promotions = 0;

  constructor() {
    this.firstArchiveWriteStarted = new Promise<void>((resolve) => {
      this.#signalFirstArchiveWriteStarted = resolve;
    });
  }

  releaseFirstArchiveWrite(): void {
    this.#releaseFirstArchiveWrite();
  }

  get promotions(): number {
    return this.#promotions;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readText(path: string): Promise<string> {
    const contents = this.files.get(path);
    if (!contents) throw new Error(`Missing ${path}`);
    return contents.toString("utf8");
  }

  async readBytes(path: string): Promise<Buffer> {
    const contents = this.files.get(path);
    if (!contents) throw new Error(`Missing ${path}`);
    return contents;
  }

  async write(path: string, contents: SnapshotContents): Promise<void> {
    if (path.startsWith("snapshots/") && this.#firstArchiveWrite) {
      this.#firstArchiveWrite = false;
      this.#signalFirstArchiveWriteStarted();
      await new Promise<void>((resolve) => {
        this.#releaseFirstArchiveWrite = resolve;
      });
    }
    this.files.set(
      path,
      typeof contents === "string" ? Buffer.from(contents) : contents,
    );
    if (path === "latest.json") this.#promotions += 1;
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
}

describe("checkpointAndCloseDatabase", () => {
  test("drains an accepted write and promotes a second snapshot after an in-flight dump", async () => {
    const store = new GatedSnapshotStore();
    let dumpRuns = 0;
    const snapshots = new SnapshotService({
      store,
      dump: async () => Buffer.from(`database-${++dumpRuns}`),
      createId: () => `snapshot-${dumpRuns}`,
    });
    const mutations = new MutationDrain();
    snapshots.markDirty();
    const firstCheckpoint = snapshots.checkpoint();
    await store.firstArchiveWriteStarted;

    let releaseAcceptedWrite!: () => void;
    const acceptedWrite = mutations.run(async () => {
      await new Promise<void>((resolve) => {
        releaseAcceptedWrite = resolve;
      });
      snapshots.markDirty();
    });

    let closedAfterPromotions = 0;
    const shutdown = checkpointAndCloseDatabase({
      database: {
        async close() {
          closedAfterPromotions = store.promotions;
        },
      },
      mutations,
      snapshots,
    });

    releaseAcceptedWrite();
    store.releaseFirstArchiveWrite();
    await Promise.all([acceptedWrite, firstCheckpoint, shutdown]);

    expect(dumpRuns).toBe(2);
    expect(store.promotions).toBe(2);
    expect(closedAfterPromotions).toBe(2);
    expect(snapshots.status()).toMatchObject({
      checkpointing: false,
      pendingWrites: 0,
    });
  });

  test("closes the database when a shutdown checkpoint fails", async () => {
    const mutations = new MutationDrain();
    let closed = false;

    await expect(
      checkpointAndCloseDatabase({
        database: {
          async close() {
            closed = true;
          },
        },
        mutations,
        snapshots: {
          async checkpoint() {
            throw new Error("snapshot upload failed");
          },
          status() {
            return {
              checkpointing: false,
              lastArchive: null,
              lastCheckpointAt: null,
              mode: "filesystem",
              pendingWrites: 1,
              restoredFrom: null,
            };
          },
        },
      }),
    ).rejects.toThrow("snapshot upload failed");

    expect(closed).toBe(true);
  });
});
