import { describe, expect, test, vi } from "vitest";
import {
  WorkspaceSnapshotVolume,
  type WorkspaceFilesClient,
} from "./workspace-volume.js";

function client(): WorkspaceFilesClient {
  return {
    config: {
      getHost: vi.fn(async () => new URL("https://workspace.example")),
      authenticate: vi.fn(async () => undefined),
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    },
    files: {
      getMetadata: vi.fn(async () => ({})),
      download: vi.fn(async () => ({
        contents: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("snapshot"));
            controller.close();
          },
        }),
      })),
      delete: vi.fn(async () => ({})),
    },
  };
}

describe("WorkspaceSnapshotVolume", () => {
  test("uploads the exact bytes through an authenticated raw PUT", async () => {
    const server = createServer();
    const received = new Promise<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
      contentType: string | undefined;
      body: Buffer;
    }>((resolve) => {
      server.once("request", (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          resolve({
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization,
            contentType: request.headers["content-type"],
            body: Buffer.concat(chunks),
          });
          response.writeHead(204).end();
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const workspace = {
      config: {
        getHost: vi.fn(
          async () => new URL(`http://127.0.0.1:${address.port}`),
        ),
        authenticate: vi.fn(async (headers: Headers) => {
          headers.set("Authorization", "Bearer test-token");
        }),
        fetch: databricksFetch,
      },
      files: client().files,
    } as unknown as WorkspaceFilesClient;
    const volume = new WorkspaceSnapshotVolume(
      "/Volumes/catalog/app/snapshots",
      workspace,
    );

    try {
      await volume.upload("generation/archive.tar.gz", Buffer.from("archive"));
      await expect(received).resolves.toEqual({
        method: "PUT",
        url: "/api/2.0/fs/files/Volumes/catalog/app/snapshots/generation/archive.tar.gz?overwrite=true",
        authorization: "Bearer test-token",
        contentType: "application/octet-stream",
        body: Buffer.from("archive"),
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("rejects a non-Volume root before making workspace requests", () => {
    const workspace = client();

    expect(
      () => new WorkspaceSnapshotVolume("/tmp/snapshots", workspace),
    ).toThrow("snapshot root must start with /Volumes/");
    expect(workspace.files.getMetadata).not.toHaveBeenCalled();
  });

  test.each([
    "/Volumes/catalog/schema",
    "/Volumes/catalog/schema/../snapshots",
    "/Volumes/catalog//snapshots",
  ])("rejects incomplete or unsafe Volume root %s", (root) => {
    expect(() => new WorkspaceSnapshotVolume(root, client())).toThrow(
      "snapshot root must start with /Volumes/",
    );
  });

  test("rejects paths that could escape the configured Volume", async () => {
    const workspace = client();
    const volume = new WorkspaceSnapshotVolume(
      "/Volumes/catalog/app/snapshots",
      workspace,
    );

    await expect(volume.read("../latest.json")).rejects.toThrow(
      "snapshot path must be a safe relative path",
    );
    expect(workspace.files.download).not.toHaveBeenCalled();
  });

  test("maps file operations under the configured Volume root", async () => {
    const workspace = client();
    const volume = new WorkspaceSnapshotVolume(
      "/Volumes/catalog/app/snapshots/",
      workspace,
    );

    expect(await volume.exists("generations/one.tar.gz")).toBe(true);
    expect(await volume.read("latest.json")).toBe("snapshot");
    expect(
      await volume.download("generations/one.tar.gz"),
    ).toHaveProperty("contents");
    await volume.upload("latest.json", "pointer", { overwrite: true });
    await volume.delete("generations/one.tar.gz");

    const root = "/Volumes/catalog/app/snapshots";
    expect(workspace.files.getMetadata).toHaveBeenCalledWith({
      file_path: `${root}/generations/one.tar.gz`,
    });
    expect(workspace.files.download).toHaveBeenNthCalledWith(1, {
      file_path: `${root}/latest.json`,
    });
    expect(workspace.files.download).toHaveBeenNthCalledWith(2, {
      file_path: `${root}/generations/one.tar.gz`,
    });
    expect(workspace.config.fetch).toHaveBeenCalledWith(
      `https://workspace.example/api/2.0/fs/files${root}/latest.json?overwrite=true`,
      expect.objectContaining({ method: "PUT" }),
    );
    expect(workspace.files.delete).toHaveBeenCalledWith({
      file_path: `${root}/generations/one.tar.gz`,
    });
  });

  test("reports a missing workspace file as absent", async () => {
    const workspace = client();
    vi.mocked(workspace.files.getMetadata).mockRejectedValueOnce({
      statusCode: 404,
    });
    const volume = new WorkspaceSnapshotVolume(
      "/Volumes/catalog/app/snapshots",
      workspace,
    );

    expect(await volume.exists("latest.json")).toBe(false);
  });
});
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { fetch as databricksFetch } from "@databricks/sdk-experimental";
