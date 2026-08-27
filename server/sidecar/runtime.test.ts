import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SidecarConfig } from "./config.js";
import { DurableSidecarRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("DurableSidecarRuntime", () => {
  test("creates missing parent directories for the database", async () => {
    const config = await temporaryConfig();
    config.dataDir = join(config.dataDir, "nested", "database");
    const runtime = new DurableSidecarRuntime(config);

    await runtime.start();

    expect(await runtime.database.query("select 1 as value")).toMatchObject({
      rows: [{ value: 1 }],
    });
    await runtime.stopSocket();
    await runtime.closeDatabase();
  });

  test("does not checkpoint a read-only database", async () => {
    const config = await temporaryConfig();
    const runtime = new DurableSidecarRuntime(config);
    await runtime.start();

    await runtime.database.query("select 1 as value");

    expect(await runtime.checkpoint()).toBe(false);
    await runtime.stopSocket();
    await runtime.closeDatabase();
  });

  test("restores a checkpoint after the ephemeral database directory is removed", async () => {
    const config = await temporaryConfig();
    const first = new DurableSidecarRuntime(config);
    await first.start();
    await first.database.query(
      "create table durable_note(id integer primary key, body text not null)",
    );
    await first.database.query(
      "insert into durable_note(id, body) values ($1, $2)",
      [1, "survives restart"],
    );
    expect(await first.checkpoint()).toBe(true);
    await first.stopSocket();
    await first.closeDatabase();

    await rm(config.dataDir, { recursive: true, force: true });

    const restored = new DurableSidecarRuntime(config);
    await restored.start();
    const result = await restored.database.query<{ body: string }>(
      "select body from durable_note where id = 1",
    );
    expect(result.rows).toEqual([{ body: "survives restart" }]);
    await restored.stopSocket();
    await restored.closeDatabase();
  });
});

async function temporaryConfig(): Promise<SidecarConfig> {
  const root = await mkdtemp(join(tmpdir(), "pglite-sidecar-runtime-"));
  temporaryDirectories.push(root);
  return {
    child: ["node", "child.js"],
    dataDir: join(root, "database"),
    socketHost: "127.0.0.1",
    socketPort: 0,
    maxConnections: 1,
    snapshotMode: "filesystem",
    snapshotDirectory: join(root, "snapshots"),
    snapshotIntervalMs: 30_000,
    snapshotRetention: 3,
    shutdownTimeoutMs: 10_000,
  };
}
