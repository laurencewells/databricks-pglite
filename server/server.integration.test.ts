import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const childProcesses: ChildProcess[] = [];
const temporaryDirectories: string[] = [];
const readinessTimeoutMs = 10_000;
const readinessPollIntervalMs = 50;

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (!hasExited(child)) child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local server startup", () => {
  it("listens in filesystem mode without Databricks authentication", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "pglite-server-"));
    temporaryDirectories.push(stateDirectory);
    const { response } = await startLocalServer(stateDirectory);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { displayName: "Local developer" },
      durability: { mode: "filesystem" },
    });
  }, 15_000);

  it("marks a reused local database dirty after an uncheckpointed crash", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "pglite-server-"));
    temporaryDirectories.push(stateDirectory);
    const first = await startLocalServer(stateDirectory);
    await fetch(`http://127.0.0.1:${first.port}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "not checkpointed before crash" }),
    });
    first.child.kill("SIGKILL");
    await exited(first.child);

    const restarted = await startLocalServer(stateDirectory);
    const status = await restarted.response.json();

    expect(status.durability.pendingWrites).toBeGreaterThan(0);
  }, 20_000);

  it("does not mark repeated trusted SQL reads dirty", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "pglite-server-"));
    temporaryDirectories.push(stateDirectory);
    const server = await startLocalServer(stateDirectory);

    for (let requestNumber = 0; requestNumber < 3; requestNumber += 1) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/sql/query`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "SELECT 1 AS value", values: [] }),
        },
      );
      expect(response.status).toBe(200);
    }

    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/app/status`,
    );
    await expect(statusResponse.json()).resolves.toMatchObject({
      durability: { pendingWrites: 0 },
    });
  }, 20_000);

  it("restores every write accepted during graceful shutdown", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "pglite-server-"));
    temporaryDirectories.push(stateDirectory);
    const first = await startLocalServer(stateDirectory);
    await fetch(`http://127.0.0.1:${first.port}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "accepted before shutdown" }),
    });

    first.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lateResponse = await fetch(
      `http://127.0.0.1:${first.port}/api/notes`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "accepted during shutdown" }),
      },
    ).catch(() => null);
    await exited(first.child);

    const replacement = await startLocalServer(stateDirectory, "replacement");
    const notesResponse = await fetch(
      `http://127.0.0.1:${replacement.port}/api/notes`,
    );
    const notes = (await notesResponse.json()).notes as Array<{ body: string }>;
    expect(notes.map((note) => note.body)).toContain("accepted before shutdown");
    if (lateResponse?.ok) {
      expect(notes.map((note) => note.body)).toContain(
        "accepted during shutdown",
      );
    }
  }, 30_000);
});

describe("status readiness", () => {
  it("reports a signaled child exit while its status request is stalled", async () => {
    const stalled = await stalledServer(250);
    const child = idleChild();
    setTimeout(() => child.kill("SIGTERM"), 50);

    try {
      const startedAt = performance.now();
      await expect(
        waitForStatus(
          stalled.port,
          child,
          () => "child received SIGTERM",
          { timeoutMs: 500, pollIntervalMs: 10 },
        ),
      ).rejects.toThrow("Server exited before listening:\nchild received SIGTERM");
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await stalled.close();
    }
  }, 12_000);

  it("bounds a stalled status request by the remaining readiness deadline", async () => {
    const stalled = await stalledServer(250);
    const child = idleChild();

    try {
      const startedAt = performance.now();
      await expect(
        waitForStatus(stalled.port, child, () => "stalled status", {
          timeoutMs: 100,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow("Server did not listen in time:\nstalled status");
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await stalled.close();
    }
  }, 12_000);
});

async function startLocalServer(
  stateDirectory: string,
  dataDirectoryName = "pglite",
) {
  const port = await availablePort();
  const environmentWithoutDatabricks = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DATABRICKS_")),
  );
  let output = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/server.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...environmentWithoutDatabricks,
        ALLOW_LOCAL_IDENTITY: "true",
        DATABRICKS_APP_PORT: String(port),
        DATABRICKS_CONFIG_FILE: join(stateDirectory, "missing-databrickscfg"),
        NODE_ENV: "development",
        PGLITE_DATA_DIR: join(stateDirectory, dataDirectoryName),
        SNAPSHOT_DIRECTORY: join(stateDirectory, "snapshots"),
        SNAPSHOT_INTERVAL_MS: "60000",
        SNAPSHOT_MODE: "filesystem",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  childProcesses.push(child);
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));
  const response = await waitForStatus(port, child, () => output);
  return { child, port, response };
}

function idleChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"]);
  childProcesses.push(child);
  return child;
}

async function stalledServer(disconnectAfterMs: number) {
  const server = createHttpServer((_request, response) => {
    setTimeout(() => response.destroy(), disconnectAfterMs).unref();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start a stalled test server");
  }
  return {
    port: address.port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function exited(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local test port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForStatus(
  port: number,
  child: ChildProcess,
  output: () => string,
  {
    timeoutMs = readinessTimeoutMs,
    pollIntervalMs = readinessPollIntervalMs,
  }: ReadinessOptions = {},
): Promise<Response> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    throwIfExited(child, output);
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) throw readinessTimeoutError(output);
    try {
      return await fetchStatus(port, child, output, remainingMs);
    } catch (error) {
      if (error instanceof ReadinessFailure) throw error;
      throwIfExited(child, output);
      const retryRemainingMs = deadline - performance.now();
      if (retryRemainingMs <= 0) throw readinessTimeoutError(output);
      await waitForRetryOrExit(
        child,
        Math.min(pollIntervalMs, retryRemainingMs),
      );
    }
  }
}

type ReadinessOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

class ReadinessFailure extends Error {}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function throwIfExited(child: ChildProcess, output: () => string): void {
  if (hasExited(child)) throw childExitError(output);
}

function childExitError(output: () => string): ReadinessFailure {
  return new ReadinessFailure(`Server exited before listening:\n${output()}`);
}

function readinessTimeoutError(output: () => string): ReadinessFailure {
  return new ReadinessFailure(`Server did not listen in time:\n${output()}`);
}

async function fetchStatus(
  port: number,
  child: ChildProcess,
  output: () => string,
  remainingMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let abortedFor: "child-exit" | "deadline" | undefined;
  const abort = (reason: "child-exit" | "deadline") => {
    if (abortedFor) return;
    abortedFor = reason;
    controller.abort();
  };
  const onExit = () => abort("child-exit");
  const deadlineTimer = setTimeout(() => abort("deadline"), remainingMs);
  child.once("exit", onExit);
  if (hasExited(child)) abort("child-exit");

  try {
    return await fetch(`http://127.0.0.1:${port}/api/app/status`, {
      signal: controller.signal,
    });
  } catch (error) {
    if (abortedFor === "child-exit") throw childExitError(output);
    if (abortedFor === "deadline") throw readinessTimeoutError(output);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    child.off("exit", onExit);
  }
}

async function waitForRetryOrExit(
  child: ChildProcess,
  delayMs: number,
): Promise<void> {
  if (hasExited(child)) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = () => finish();
    child.once("exit", onExit);
    timeout = setTimeout(finish, Math.max(delayMs, 0));
    if (hasExited(child)) finish();
  });
}
