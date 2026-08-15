import { describe, expect, test } from "vitest";
import type { SnapshotStore } from "./types.js";
import { SnapshotService } from "./service.js";

class MemorySnapshotStore implements SnapshotStore {
  readonly files = new Map<string, Buffer>();
  readonly operations: string[] = [];
  failWritePath?: string;
  failDeletePath?: string;

  async exists(path: string) {
    return this.files.has(path);
  }

  async readText(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing ${path}`);
    return value.toString("utf8");
  }

  async readBytes(path: string) {
    const value = this.files.get(path);
    if (!value) throw new Error(`Missing ${path}`);
    return value;
  }

  async write(path: string, contents: Buffer | string) {
    this.operations.push(`write:${path}`);
    if (this.failWritePath === path) throw new Error("simulated upload failure");
    this.files.set(
      path,
      typeof contents === "string" ? Buffer.from(contents) : contents,
    );
  }

  async delete(path: string) {
    this.operations.push(`delete:${path}`);
    if (this.failDeletePath === path) throw new Error("simulated delete failure");
    this.files.delete(path);
  }
}

describe("SnapshotService", () => {
  test("returns no archive when no pointer exists", async () => {
    const service = new SnapshotService({
      store: new MemorySnapshotStore(),
      dump: async () => Buffer.from("unused"),
    });

    expect(await service.restoreLatest()).toBeNull();
    expect(service.status().restoredFrom).toBeNull();
  });

  test("writes the archive before advancing the latest pointer", async () => {
    const store = new MemorySnapshotStore();
    const service = new SnapshotService({
      store,
      dump: async () => Buffer.from("database"),
      clock: () => new Date("2026-08-13T08:00:00.000Z"),
      createId: () => "abc123",
      mode: "appkit",
    });
    service.markDirty();

    const manifest = await service.checkpoint();

    expect(store.operations).toEqual([
      "write:snapshots/2026-08-13T08-00-00-000Z-abc123.tar.gz",
      "write:latest.json",
    ]);
    expect(manifest.archive).toBe(
      "snapshots/2026-08-13T08-00-00-000Z-abc123.tar.gz",
    );
    expect(service.status()).toMatchObject({
      mode: "appkit",
      pendingWrites: 0,
      lastCheckpointAt: "2026-08-13T08:00:00.000Z",
    });
  });

  test("keeps writes that arrive after the database dump marked as pending", async () => {
    const store = new MemorySnapshotStore();
    const originalWrite = store.write.bind(store);
    let service: SnapshotService;
    store.write = async (path, contents) => {
      await originalWrite(path, contents);
      if (path.startsWith("snapshots/")) service.markDirty();
    };
    service = new SnapshotService({
      store,
      dump: async () => Buffer.from("database before concurrent write"),
    });
    service.markDirty();

    await service.checkpoint();

    expect(service.status().pendingWrites).toBe(1);
  });

  test("shares an in-flight checkpoint with concurrent callers", async () => {
    const store = new MemorySnapshotStore();
    let dumpRuns = 0;
    let signalDumpStarted: () => void = () => {};
    let releaseDump: (contents: Buffer) => void = () => {};
    const dumpStarted = new Promise<void>((resolve) => {
      signalDumpStarted = resolve;
    });
    const dump = new Promise<Buffer>((resolve) => {
      releaseDump = resolve;
    });
    const service = new SnapshotService({
      store,
      dump: async () => {
        dumpRuns += 1;
        signalDumpStarted();
        return dump;
      },
    });

    const firstCheckpoint = service.checkpoint();
    await dumpStarted;
    expect(service.status().checkpointing).toBe(true);

    const secondCheckpoint = service.checkpoint();
    releaseDump(Buffer.from("database"));

    const [firstManifest, secondManifest] = await Promise.all([
      firstCheckpoint,
      secondCheckpoint,
    ]);

    expect(secondManifest).toBe(firstManifest);
    expect(dumpRuns).toBe(1);
    expect(service.status().checkpointing).toBe(false);
  });

  test("preserves the previous pointer when archive upload fails", async () => {
    const store = new MemorySnapshotStore();
    const seed = new SnapshotService({
      store,
      dump: async () => Buffer.from("previous database"),
      clock: () => new Date("2026-08-13T07:59:00.000Z"),
      createId: () => "previous",
    });
    await seed.checkpoint();
    const previousPointer = Buffer.from(store.files.get("latest.json")!);
    store.failWritePath =
      "snapshots/2026-08-13T08-00-00-000Z-failed.tar.gz";
    const service = new SnapshotService({
      store,
      dump: async () => Buffer.from("database"),
      clock: () => new Date("2026-08-13T08:00:00.000Z"),
      createId: () => "failed",
    });

    await expect(service.checkpoint()).rejects.toThrow(
      "simulated upload failure",
    );
    expect(store.files.get("latest.json")).toEqual(previousPointer);
  });

  test("rejects a corrupted latest archive", async () => {
    const store = new MemorySnapshotStore();
    const writer = new SnapshotService({
      store,
      dump: async () => Buffer.from("database"),
      clock: () => new Date("2026-08-13T08:00:00.000Z"),
      createId: () => "valid",
    });
    const manifest = await writer.checkpoint();
    store.files.set(manifest.archive, Buffer.from("corrupt"));
    const reader = new SnapshotService({
      store,
      dump: async () => Buffer.from("unused"),
    });

    await expect(reader.restoreLatest()).rejects.toThrow(
      "Snapshot checksum verification failed",
    );
  });

  test("deletes generations beyond the configured retention after promotion", async () => {
    const store = new MemorySnapshotStore();
    let generation = 0;
    const service = new SnapshotService({
      store,
      dump: async () => Buffer.from(`database-${generation}`),
      clock: () => new Date(`2026-08-13T08:00:0${generation}.000Z`),
      createId: () => `id${generation++}`,
      retention: 2,
    });

    const first = await service.checkpoint();
    await service.checkpoint();
    const third = await service.checkpoint();

    expect(await store.exists(first.archive)).toBe(false);
    expect(await store.exists(third.archive)).toBe(true);
    expect(
      store.operations.indexOf("write:latest.json"),
    ).toBeLessThan(store.operations.indexOf(`delete:${first.archive}`));
  });

  test("keeps a promoted checkpoint successful when retention cleanup fails", async () => {
    const store = new MemorySnapshotStore();
    const cleanupErrors: unknown[] = [];
    let generation = 0;
    const service = new SnapshotService({
      store,
      dump: async () => Buffer.from(`database-${generation}`),
      createId: () => `id${generation++}`,
      retention: 1,
      onCleanupError: (error) => cleanupErrors.push(error),
    });
    const first = await service.checkpoint();
    service.markDirty();
    store.failDeletePath = first.archive;

    const promoted = await service.checkpoint();

    expect(promoted.archive).not.toBe(first.archive);
    expect(service.status()).toMatchObject({
      pendingWrites: 0,
      lastArchive: promoted.archive,
    });
    expect(cleanupErrors).toHaveLength(1);
  });
});
