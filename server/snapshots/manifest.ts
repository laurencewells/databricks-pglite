import { createHash } from "node:crypto";

export interface SnapshotManifest {
  version: 1;
  archive: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  retainedArchives: string[];
}

const ARCHIVE_PATTERN = /^snapshots\/[A-Za-z0-9._-]+\.tar\.gz$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function snapshotSha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function createSnapshotManifest(input: {
  archive: string;
  contents: Buffer;
  createdAt: string;
  retainedArchives: string[];
}): SnapshotManifest {
  return parseSnapshotManifest(
    JSON.stringify({
      version: 1,
      archive: input.archive,
      sha256: snapshotSha256(input.contents),
      bytes: input.contents.byteLength,
      createdAt: input.createdAt,
      retainedArchives: input.retainedArchives,
    }),
  );
}

export function parseSnapshotManifest(raw: string): SnapshotManifest {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("not an object");
    const candidate = value as Record<string, unknown>;
    const retainedArchives = candidate.retainedArchives;
    if (
      candidate.version !== 1 ||
      typeof candidate.archive !== "string" ||
      !ARCHIVE_PATTERN.test(candidate.archive) ||
      typeof candidate.sha256 !== "string" ||
      !SHA256_PATTERN.test(candidate.sha256) ||
      typeof candidate.bytes !== "number" ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes < 0 ||
      typeof candidate.createdAt !== "string" ||
      Number.isNaN(Date.parse(candidate.createdAt)) ||
      !Array.isArray(retainedArchives) ||
      !retainedArchives.every(
        (archive) => typeof archive === "string" && ARCHIVE_PATTERN.test(archive),
      )
    ) {
      throw new Error("invalid fields");
    }
    return {
      version: 1,
      archive: candidate.archive,
      sha256: candidate.sha256,
      bytes: candidate.bytes,
      createdAt: candidate.createdAt,
      retainedArchives: [...retainedArchives] as string[],
    };
  } catch (error) {
    throw new Error("Invalid snapshot manifest", { cause: error });
  }
}

export function verifySnapshot(
  manifest: SnapshotManifest,
  contents: Buffer,
): boolean {
  return (
    contents.byteLength === manifest.bytes &&
    snapshotSha256(contents) === manifest.sha256
  );
}
