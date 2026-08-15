import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { SnapshotContents, SnapshotStore } from "./types.js";

export class LocalSnapshotStore implements SnapshotStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #resolve(snapshotPath: string): string {
    const resolved = resolve(this.#root, snapshotPath);
    if (resolved !== this.#root && !resolved.startsWith(`${this.#root}${sep}`)) {
      throw new Error("Snapshot path must stay within the configured root");
    }
    return resolved;
  }

  async exists(snapshotPath: string): Promise<boolean> {
    try {
      await readFile(this.#resolve(snapshotPath));
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async readText(snapshotPath: string): Promise<string> {
    return readFile(this.#resolve(snapshotPath), "utf8");
  }

  async readBytes(snapshotPath: string): Promise<Buffer> {
    return readFile(this.#resolve(snapshotPath));
  }

  async write(
    snapshotPath: string,
    contents: SnapshotContents,
  ): Promise<void> {
    const destination = this.#resolve(snapshotPath);
    await mkdir(dirname(destination), { recursive: true });
    if (snapshotPath !== "latest.json") {
      await writeFile(destination, contents);
      return;
    }

    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async delete(snapshotPath: string): Promise<void> {
    await rm(this.#resolve(snapshotPath), { force: true });
  }
}
