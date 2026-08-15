import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AppKitSnapshotStore,
  type SnapshotVolume,
} from "./appkit-store.js";
import { LocalSnapshotStore } from "./local-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LocalSnapshotStore", () => {
  test("round-trips nested binary snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pglite-store-"));
    temporaryDirectories.push(directory);
    const store = new LocalSnapshotStore(directory);
    const expected = Buffer.from([0, 1, 2, 127, 255]);

    await store.write("snapshots/generation.tar.gz", expected);

    expect(await store.exists("snapshots/generation.tar.gz")).toBe(true);
    expect(await store.readBytes("snapshots/generation.tar.gz")).toEqual(
      expected,
    );
    await store.delete("snapshots/generation.tar.gz");
    expect(await store.exists("snapshots/generation.tar.gz")).toBe(false);
  });

  test("rejects paths outside its root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pglite-store-"));
    temporaryDirectories.push(directory);
    const store = new LocalSnapshotStore(directory);

    await expect(store.write("../escape", "unsafe")).rejects.toThrow(
      "Snapshot path must stay within the configured root",
    );
  });

  test("atomically replaces the latest pointer without opening it in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pglite-store-"));
    temporaryDirectories.push(directory);
    const store = new LocalSnapshotStore(directory);
    await store.write("latest.json", "old pointer");
    await chmod(join(directory, "latest.json"), 0o400);

    await store.write("latest.json", "new pointer");

    expect(await store.readText("latest.json")).toBe("new pointer");
  });
});

describe("AppKitSnapshotStore", () => {
  test("round-trips streamed volume downloads and overwrites pointers", async () => {
    const files = new Map<string, Buffer>();
    const volume = {
      async exists(path: string) {
        return files.has(path);
      },
      async read(path: string) {
        const value = files.get(path);
        if (!value) throw new Error("missing");
        return value.toString("utf8");
      },
      async download(path: string) {
        const value = files.get(path);
        if (!value) throw new Error("missing");
        const split = Math.max(1, Math.floor(value.length / 2));
        return {
          contents: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(value.subarray(0, split));
              controller.enqueue(value.subarray(split));
              controller.close();
            },
          }),
        };
      },
      async upload(
        path: string,
        contents: ReadableStream | Buffer | string,
        options?: { overwrite?: boolean },
      ) {
        if (options?.overwrite !== true) throw new Error("overwrite required");
        if (contents instanceof ReadableStream) {
          throw new Error("test fake expects buffered uploads");
        }
        files.set(
          path,
          typeof contents === "string" ? Buffer.from(contents) : contents,
        );
      },
      async delete(path: string) {
        files.delete(path);
      },
    } satisfies SnapshotVolume;
    const store = new AppKitSnapshotStore(volume);
    const expected = Buffer.from("archive-content");

    await store.write("snapshots/one.tar.gz", expected);
    await store.write("latest.json", "{\"generation\":1}");

    expect(await store.readBytes("snapshots/one.tar.gz")).toEqual(expected);
    expect(await store.readText("latest.json")).toBe("{\"generation\":1}");
    await store.delete("snapshots/one.tar.gz");
    expect(await store.exists("snapshots/one.tar.gz")).toBe(false);
  });
});
