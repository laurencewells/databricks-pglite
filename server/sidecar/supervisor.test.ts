import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import type { SidecarConfig } from "./config.js";
import {
  SidecarSupervisor,
  type ChildHandle,
  type SidecarRuntime,
} from "./supervisor.js";

const config: SidecarConfig = {
  child: ["uv", "run", "uvicorn", "app:app"],
  dataDir: ".data/pglite",
  socketHost: "127.0.0.1",
  socketPort: 5432,
  maxConnections: 1,
  snapshotMode: "filesystem",
  snapshotDirectory: ".data/snapshots",
  snapshotIntervalMs: 30_000,
  snapshotRetention: 3,
  shutdownTimeoutMs: 10_000,
};

describe("SidecarSupervisor", () => {
  test("does not spawn the child when shutdown is requested during startup", async () => {
    const events: string[] = [];
    const startup = deferred<void>();
    const runtime = runtimeRecorder(events);
    runtime.start = async () => {
      events.push("restore");
      await startup.promise;
      events.push("listen");
    };
    let spawned = false;
    const supervisor = new SidecarSupervisor(config, runtime, {
      spawnChild: () => {
        spawned = true;
        return new TestChild(events);
      },
      log: () => undefined,
    });

    const starting = supervisor.start();
    const shuttingDown = supervisor.shutdown("SIGTERM");
    startup.resolve();
    await starting;
    await shuttingDown;

    expect(spawned).toBe(false);
    expect(events).toEqual([
      "restore",
      "listen",
      "socket:stop",
      "checkpoint",
      "database:close",
    ]);
  });

  test("continues shutdown when startup rejects after a signal", async () => {
    const events: string[] = [];
    const startup = deferred<void>();
    const runtime = runtimeRecorder(events);
    runtime.start = async () => {
      events.push("restore");
      await startup.promise;
    };
    const supervisor = new SidecarSupervisor(config, runtime, {
      spawnChild: () => new TestChild(events),
      log: () => undefined,
    });

    const starting = supervisor.start();
    const shuttingDown = supervisor.shutdown("SIGTERM");
    startup.reject(new Error("restore failed"));

    await expect(starting).rejects.toThrow("restore failed");
    expect(await shuttingDown).toBe(1);
    expect(events).toEqual([
      "restore",
      "socket:stop",
      "database:close",
    ]);
  });

  test("does not race teardown against startup after the shutdown deadline", async () => {
    const events: string[] = [];
    const runtime = runtimeRecorder(events);
    runtime.start = async () => {
      events.push("restore");
      await new Promise<void>(() => undefined);
    };
    const supervisor = new SidecarSupervisor(
      { ...config, shutdownTimeoutMs: 20 },
      runtime,
      {
        spawnChild: () => new TestChild(events),
        log: () => undefined,
        hardExit: () => undefined,
      },
    );
    void supervisor.start();

    expect(await supervisor.shutdown("SIGTERM")).toBe(1);
    expect(events).toEqual(["restore"]);
  });

  test("starts durable storage and the socket before spawning the exact child argv", async () => {
    const events: string[] = [];
    const runtime = runtimeRecorder(events);
    const child = new TestChild(events);
    let spawned:
      | { executable: string; arguments_: string[]; environment: NodeJS.ProcessEnv }
      | undefined;
    const supervisor = new SidecarSupervisor(config, runtime, {
      spawnChild(executable, arguments_, options) {
        events.push("spawn");
        spawned = { executable, arguments_, environment: options.env ?? {} };
        return child;
      },
      log: () => undefined,
    });

    await supervisor.start();

    expect(events).toEqual(["restore", "database", "listen", "spawn"]);
    expect(spawned).toMatchObject({
      executable: "uv",
      arguments_: ["run", "uvicorn", "app:app"],
    });
    const databaseUrl = new URL(String(spawned?.environment.DATABASE_URL));
    expect(databaseUrl).toMatchObject({
      protocol: "postgresql:",
      username: "postgres",
      password: "postgres",
      hostname: "127.0.0.1",
      port: "5432",
      pathname: "/postgres",
    });
    const asyncpgUrl = new URL(String(spawned?.environment.LOCAL_PG_DSN));
    expect(asyncpgUrl).toMatchObject({
      protocol: "postgresql+asyncpg:",
      username: "postgres",
      password: "postgres",
      hostname: "127.0.0.1",
      port: "5432",
      pathname: "/postgres",
      search: "?ssl=disable",
    });

    child.exit(0);
    await supervisor.wait();
  });

  test("never writes the injected database URLs to logs", async () => {
    const events: string[] = [];
    const child = new TestChild(events);
    const logs: string[] = [];
    const supervisor = new SidecarSupervisor(config, runtimeRecorder(events), {
      spawnChild: () => child,
      log: (message) => logs.push(message),
    });

    await supervisor.start();
    child.exit(0);
    await supervisor.wait();

    expect(logs.join("\n")).not.toContain("postgres:postgres");
    expect(logs.join("\n")).not.toContain("LOCAL_PG_DSN");
  });

  test("terminates the child before stopping the socket and taking the final checkpoint", async () => {
    const events: string[] = [];
    const child = new TestChild(events);
    const supervisor = new SidecarSupervisor(config, runtimeRecorder(events), {
      spawnChild: () => child,
      log: () => undefined,
    });
    await supervisor.start();
    events.splice(0);

    const exitCode = await supervisor.shutdown("SIGTERM");

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "child:SIGTERM",
      "child:exit",
      "socket:stop",
      "checkpoint",
      "database:close",
    ]);
  });

  test("propagates a child failure after closing durable storage", async () => {
    const events: string[] = [];
    const child = new TestChild(events);
    const supervisor = new SidecarSupervisor(config, runtimeRecorder(events), {
      spawnChild: () => child,
      log: () => undefined,
    });
    await supervisor.start();
    events.splice(0);

    child.exit(23);

    expect(await supervisor.wait()).toBe(23);
    expect(events).toEqual([
      "child:exit",
      "socket:stop",
      "checkpoint",
      "database:close",
    ]);
  });

  test("closes partial runtime state when startup fails before spawning the child", async () => {
    const events: string[] = [];
    const runtime = runtimeRecorder(events);
    runtime.start = async () => {
      events.push("restore", "database");
      throw new Error("socket bind failed");
    };
    const spawnChild = () => {
      throw new Error("child must not start");
    };
    const supervisor = new SidecarSupervisor(config, runtime, {
      spawnChild,
      log: () => undefined,
    });

    await expect(supervisor.start()).rejects.toThrow("socket bind failed");
    expect(events).toEqual([
      "restore",
      "database",
      "socket:stop",
      "database:close",
    ]);
  });

  test("attempts the final checkpoint when socket shutdown fails", async () => {
    const events: string[] = [];
    const runtime = runtimeRecorder(events);
    runtime.stopSocket = async () => {
      events.push("socket:stop");
      throw new Error("socket stop failed");
    };
    const child = new TestChild(events);
    const supervisor = new SidecarSupervisor(config, runtime, {
      spawnChild: () => child,
      log: () => undefined,
    });
    await supervisor.start();
    events.splice(0);

    expect(await supervisor.shutdown("SIGTERM")).toBe(1);
    expect(events).toEqual([
      "child:SIGTERM",
      "child:exit",
      "socket:stop",
      "checkpoint",
      "database:close",
    ]);
  });

  test("bounds a final checkpoint that never settles", async () => {
    const events: string[] = [];
    const runtime = runtimeRecorder(events);
    runtime.checkpoint = async () => new Promise<boolean>(() => undefined);
    const child = new TestChild(events);
    const supervisor = new SidecarSupervisor(
      { ...config, shutdownTimeoutMs: 20 },
      runtime,
      {
        spawnChild: () => child,
        log: () => undefined,
        hardExit: () => undefined,
      },
    );
    await supervisor.start();

    const result = await Promise.race([
      supervisor.shutdown("SIGTERM"),
      delay(200).then(() => "timed out" as const),
    ]);

    expect(result).toBe(1);
    expect(events).not.toContain("database:close");
  });

  test("bounds the wait after force-killing an unresponsive child", async () => {
    const events: string[] = [];
    const child = new UnresponsiveChild(events);
    const supervisor = new SidecarSupervisor(
      { ...config, shutdownTimeoutMs: 20 },
      runtimeRecorder(events),
      {
        spawnChild: () => child,
        log: () => undefined,
        hardExit: () => undefined,
      },
    );
    await supervisor.start();

    const result = await Promise.race([
      supervisor.shutdown("SIGTERM"),
      delay(200).then(() => "timed out" as const),
    ]);

    expect(result).toBe(1);
    expect(events).toContain("child:SIGKILL");
    expect(events).not.toContain("socket:stop");
  });
});

function runtimeRecorder(events: string[]): SidecarRuntime {
  return {
    async start() {
      events.push("restore", "database", "listen");
    },
    async checkpoint() {
      events.push("checkpoint");
      return false;
    },
    async stopSocket() {
      events.push("socket:stop");
    },
    async closeDatabase() {
      events.push("database:close");
    },
  };
}

class TestChild extends EventEmitter implements ChildHandle {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(protected readonly events: string[]) {
    super();
  }

  kill(signal: NodeJS.Signals): boolean {
    this.events.push(`child:${signal}`);
    this.exit(0);
    return true;
  }

  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.events.push("child:exit");
    this.emit("exit", code, null);
  }
}

class UnresponsiveChild extends TestChild {
  override kill(signal: NodeJS.Signals): boolean {
    this.events.push(`child:${signal}`);
    return true;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
