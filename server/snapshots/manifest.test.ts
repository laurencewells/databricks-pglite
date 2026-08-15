import { describe, expect, test } from "vitest";
import {
  createSnapshotManifest,
  parseSnapshotManifest,
  verifySnapshot,
} from "./manifest.js";

describe("snapshot manifests", () => {
  test("records a hand-verified SHA-256 digest", () => {
    const manifest = createSnapshotManifest({
      archive: "snapshots/one.tar.gz",
      contents: Buffer.from("hello"),
      createdAt: "2026-08-13T08:00:00.000Z",
      retainedArchives: [],
    });

    expect(manifest).toEqual({
      version: 1,
      archive: "snapshots/one.tar.gz",
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      bytes: 5,
      createdAt: "2026-08-13T08:00:00.000Z",
      retainedArchives: [],
    });
    expect(verifySnapshot(manifest, Buffer.from("hello"))).toBe(true);
    expect(verifySnapshot(manifest, Buffer.from("changed"))).toBe(false);
  });

  test("rejects malformed or unsafe pointers", () => {
    expect(() =>
      parseSnapshotManifest(
        JSON.stringify({
          version: 1,
          archive: "../outside.tar.gz",
          sha256: "not-a-digest",
          bytes: -1,
          createdAt: "yesterday",
          retainedArchives: [],
        }),
      ),
    ).toThrow("Invalid snapshot manifest");
  });
});
