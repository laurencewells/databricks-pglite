import type { SnapshotContents, SnapshotStore } from "./types.js";

export interface SnapshotVolume {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  download(
    path: string,
  ): Promise<{ contents?: ReadableStream<Uint8Array> | undefined }>;
  upload(
    path: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ): Promise<void>;
  delete(path: string): Promise<void>;
}

export class AppKitSnapshotStore implements SnapshotStore {
  constructor(private readonly volume: SnapshotVolume) {}

  exists(path: string): Promise<boolean> {
    return this.volume.exists(path);
  }

  readText(path: string): Promise<string> {
    return this.volume.read(path);
  }

  async readBytes(path: string): Promise<Buffer> {
    const response = await this.volume.download(path);
    if (!response.contents) return Buffer.alloc(0);

    const chunks: Uint8Array[] = [];
    const reader = response.contents.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  write(path: string, contents: SnapshotContents): Promise<void> {
    return this.volume.upload(path, contents, { overwrite: true });
  }

  delete(path: string): Promise<void> {
    return this.volume.delete(path);
  }
}
