export type SnapshotContents = Buffer | string;

export interface SnapshotStore {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  write(path: string, contents: SnapshotContents): Promise<void>;
  delete(path: string): Promise<void>;
}
