import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CheckpointCoordinator } from "./checkpoint-coordinator.js";
import { SidecarExecutionBarrier } from "./execution-barrier.js";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("CheckpointCoordinator", () => {
  test("checkpoints committed writes but not reads", async () => {
    const database = await PGlite.create();
    databases.push(database);
    const snapshots = snapshotsRecorder();
    const coordinator = new CheckpointCoordinator(
      database,
      snapshots,
      new SidecarExecutionBarrier(),
    );

    expect(await coordinator.captureWritesAndCheckpoint()).toBe(false);
    await database.query("select 1 as value");
    expect(await coordinator.captureWritesAndCheckpoint()).toBe(false);
    await database.query("create table durable_note(id integer primary key)");
    expect(await coordinator.captureWritesAndCheckpoint()).toBe(true);

    expect(snapshots.markDirty).toHaveBeenCalledTimes(1);
    expect(snapshots.checkpoint).toHaveBeenCalledTimes(1);
  });

  test("defers a changed WAL position until an open transaction finishes", async () => {
    const database = await PGlite.create();
    databases.push(database);
    const snapshots = snapshotsRecorder();
    const coordinator = new CheckpointCoordinator(
      database,
      snapshots,
      new SidecarExecutionBarrier(),
    );
    await coordinator.captureWritesAndCheckpoint();
    await database.exec("begin");
    await database.exec("create table pending_note(id integer primary key)");

    expect(await coordinator.captureWritesAndCheckpoint()).toBe(false);
    expect(snapshots.checkpoint).not.toHaveBeenCalled();

    await database.exec("commit");
    expect(await coordinator.captureWritesAndCheckpoint()).toBe(true);
    expect(snapshots.checkpoint).toHaveBeenCalledTimes(1);
  });

  test("keeps a failed checkpoint eligible for retry without double-counting dirty state", async () => {
    const database = await PGlite.create();
    databases.push(database);
    const snapshots = snapshotsRecorder();
    const coordinator = new CheckpointCoordinator(
      database,
      snapshots,
      new SidecarExecutionBarrier(),
    );
    await coordinator.captureWritesAndCheckpoint();
    await database.query("create table retry_note(id integer primary key)");
    snapshots.checkpoint.mockRejectedValueOnce(new Error("upload failed"));

    await expect(coordinator.captureWritesAndCheckpoint()).rejects.toThrow(
      "upload failed",
    );
    expect(await coordinator.captureWritesAndCheckpoint()).toBe(true);

    expect(snapshots.markDirty).toHaveBeenCalledTimes(1);
    expect(snapshots.checkpoint).toHaveBeenCalledTimes(2);
  });

  test("checkpoints pre-existing dirty state even when the WAL baseline is unchanged", async () => {
    const database = await PGlite.create();
    databases.push(database);
    const snapshots = snapshotsRecorder();
    const coordinator = new CheckpointCoordinator(
      database,
      snapshots,
      new SidecarExecutionBarrier(),
    );
    await coordinator.captureWritesAndCheckpoint();
    snapshots.markDirty();

    expect(await coordinator.captureWritesAndCheckpoint()).toBe(true);
    expect(snapshots.checkpoint).toHaveBeenCalledTimes(1);
  });
});

function snapshotsRecorder() {
  let pendingWrites = 0;
  return {
    markDirty: vi.fn(() => {
      pendingWrites += 1;
    }),
    checkpoint: vi.fn(async () => {
      pendingWrites = 0;
    }),
    status: vi.fn(() => ({ pendingWrites })),
  };
}
