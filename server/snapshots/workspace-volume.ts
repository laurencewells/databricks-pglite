import { createWorkspaceClient } from "@databricks/appkit";
import { Readable } from "node:stream";
import {
  AppKitSnapshotStore,
  type SnapshotVolume,
} from "./appkit-store.js";
import type { SnapshotStore } from "./types.js";

interface WorkspaceDownload {
  contents?: ReadableStream<Uint8Array>;
}

export interface WorkspaceFilesClient {
  config: {
    getHost(): Promise<URL>;
    authenticate(headers: Headers): Promise<void>;
    fetch(
      url: string,
      options: { method: "PUT"; headers: Headers; body: Readable },
    ): Promise<{ ok: boolean; status: number }>;
  };
  files: {
    getMetadata(request: { file_path: string }): Promise<unknown>;
    download(request: { file_path: string }): Promise<WorkspaceDownload>;
    delete(request: { file_path: string }): Promise<unknown>;
  };
}

export class WorkspaceSnapshotVolume implements SnapshotVolume {
  private readonly root: string;

  constructor(
    root: string,
    private readonly client: WorkspaceFilesClient,
  ) {
    const normalizedRoot = root.replace(/\/+$/, "");
    const segments = normalizedRoot.split("/");
    if (
      !normalizedRoot.startsWith("/Volumes/") ||
      segments.length < 5 ||
      segments.slice(2).some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("snapshot root must start with /Volumes/");
    }
    this.root = normalizedRoot;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.client.files.getMetadata({ file_path: this.path(path) });
      return true;
    } catch (error) {
      if (statusCode(error) === 404) return false;
      throw error;
    }
  }

  async read(path: string): Promise<string> {
    const response = await this.download(path);
    if (!response.contents) return "";
    const reader = response.contents.getReader();
    const decoder = new TextDecoder();
    let value = "";
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      value += decoder.decode(chunk, { stream: true });
    }
    return value + decoder.decode();
  }

  download(path: string): Promise<WorkspaceDownload> {
    return this.client.files.download({ file_path: this.path(path) });
  }

  async upload(
    path: string,
    contents: ReadableStream | Buffer | string,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
    });
    await this.client.config.authenticate(headers);
    const url = await this.client.config.getHost();
    url.pathname = `/api/2.0/fs/files${this.path(path)}`;
    url.searchParams.set("overwrite", String(options?.overwrite ?? true));
    const response = await this.client.config.fetch(url.toString(), {
      method: "PUT",
      headers,
      body: toUploadStream(contents),
    });
    if (!response.ok) {
      const error = new Error(`workspace upload failed with HTTP ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
  }

  async delete(path: string): Promise<void> {
    await this.client.files.delete({ file_path: this.path(path) });
  }

  private path(relative: string): string {
    if (
      !relative ||
      relative.startsWith("/") ||
      relative.split("/").includes("..")
    ) {
      throw new Error("snapshot path must be a safe relative path");
    }
    return `${this.root}/${relative}`;
  }
}

export function createWorkspaceSnapshotStore(
  root: string,
  client: WorkspaceFilesClient = createWorkspaceClient() as unknown as WorkspaceFilesClient,
): SnapshotStore {
  return new AppKitSnapshotStore(new WorkspaceSnapshotVolume(root, client));
}

function toUploadStream(
  contents: ReadableStream | Buffer | string,
): Readable {
  if (contents instanceof ReadableStream) {
    return Readable.fromWeb(
      contents as unknown as import("node:stream/web").ReadableStream,
    );
  }
  return Readable.from([
    typeof contents === "string" ? Buffer.from(contents) : contents,
  ]);
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
