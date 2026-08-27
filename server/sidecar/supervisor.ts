import { spawn, type SpawnOptions } from "node:child_process";
import type { SidecarConfig } from "./config.js";

export interface ChildHandle {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface SidecarRuntime {
  start(): Promise<void>;
  checkpoint(): Promise<boolean>;
  stopSocket(): Promise<void>;
  closeDatabase(): Promise<void>;
}

interface SupervisorDependencies {
  spawnChild(
    executable: string,
    arguments_: string[],
    options: SpawnOptions,
  ): ChildHandle;
  log(message: string): void;
  hardExit(exitCode: number): void;
}

const defaultDependencies: SupervisorDependencies = {
  spawnChild: (executable, arguments_, options) =>
    spawn(executable, arguments_, options),
  log: (message) => console.log(message),
  hardExit: (exitCode) => process.exit(exitCode),
};

export class SidecarSupervisor {
  readonly #dependencies: SupervisorDependencies;
  readonly #completion: Promise<number>;
  #resolveCompletion!: (exitCode: number) => void;
  #child: ChildHandle | undefined;
  #childExit: Promise<number> | undefined;
  #resolveChildExit: ((exitCode: number) => void) | undefined;
  #checkpointTimer: NodeJS.Timeout | undefined;
  #startPromise: Promise<void> | undefined;
  #shutdownSignal: NodeJS.Signals | undefined;
  #shutdownPromise: Promise<number> | undefined;
  #shutdownFinished = false;

  constructor(
    private readonly config: SidecarConfig,
    private readonly runtime: SidecarRuntime,
    dependencies: Partial<SupervisorDependencies> = {},
  ) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
    this.#completion = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
  }

  start(): Promise<void> {
    if (!this.#startPromise) this.#startPromise = this.#performStart();
    return this.#startPromise;
  }

  async #performStart(): Promise<void> {
    try {
      await this.runtime.start();
      if (this.#shutdownSignal) {
        if (this.#shutdownFinished) {
          await this.runtime.stopSocket().catch(() => undefined);
          await this.runtime.closeDatabase().catch(() => undefined);
        }
        return;
      }
      const [executable, ...arguments_] = this.config.child;
      const urls = databaseUrls(this.config);
      this.#childExit = new Promise((resolve) => {
        this.#resolveChildExit = resolve;
      });
      this.#child = this.#dependencies.spawnChild(executable, arguments_, {
        env: {
          ...process.env,
          DATABASE_URL: urls.databaseUrl,
          LOCAL_PG_DSN: urls.asyncpgUrl,
        },
        shell: false,
        stdio: "inherit",
      });
      this.#child.once("exit", (code, signal) => {
        const exitCode = code ?? (signal ? 1 : 0);
        this.#resolveChildExit?.(exitCode);
        this.#beginShutdown(undefined, exitCode);
      });
      this.#child.once("error", () => {
        this.#resolveChildExit?.(1);
        this.#beginShutdown(undefined, 1);
      });
      this.#checkpointTimer = setInterval(() => {
        void this.runtime.checkpoint().catch((error: unknown) => {
          this.#dependencies.log(
            `Periodic checkpoint failed (${errorName(error)}); will retry`,
          );
        });
      }, this.config.snapshotIntervalMs);
      this.#checkpointTimer.unref();
      this.#dependencies.log("PGlite sidecar started child application");
    } catch (error) {
      await this.runtime.stopSocket().catch(() => undefined);
      await this.runtime.closeDatabase().catch(() => undefined);
      throw error;
    }
  }

  wait(): Promise<number> {
    return this.#completion;
  }

  shutdown(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    this.#shutdownSignal ??= signal;
    return this.#beginShutdown(signal);
  }

  #beginShutdown(
    signal: NodeJS.Signals | undefined,
    childExitCode?: number,
  ): Promise<number> {
    if (!this.#shutdownPromise) {
      const deadline = Date.now() + this.config.shutdownTimeoutMs;
      this.#shutdownPromise = Promise.resolve().then(async () => {
        if (this.#startPromise) {
          try {
            const startup = await settleBefore(this.#startPromise, deadline);
            if (!startup.completed) {
              this.#dependencies.log("Startup shutdown deadline exceeded");
              this.#dependencies.hardExit(1);
              this.#shutdownFinished = true;
              this.#resolveCompletion(1);
              return 1;
            }
          } catch (error) {
            this.#dependencies.log(`Startup failed (${errorName(error)})`);
            this.#shutdownFinished = true;
            this.#resolveCompletion(1);
            return 1;
          }
        }
        const exitCode = await this.#performShutdown(
          signal,
          childExitCode,
          deadline,
        );
        this.#shutdownFinished = true;
        this.#resolveCompletion(exitCode);
        return exitCode;
      });
    }
    return this.#shutdownPromise;
  }

  async #performShutdown(
    signal: NodeJS.Signals | undefined,
    knownExitCode?: number,
    deadline = Date.now() + this.config.shutdownTimeoutMs,
  ): Promise<number> {
    if (this.#checkpointTimer) clearInterval(this.#checkpointTimer);
    let exitCode = knownExitCode ?? 0;

    if (signal && this.#child?.exitCode === null) {
      this.#child.kill(signal);
      const childExit = await this.#boundedChildExit(deadline);
      if (!childExit.completed) return this.#hardExitAfterTimeout("Child exit");
      exitCode = childExit.value;
    } else if (knownExitCode === undefined && this.#childExit) {
      const childExit = await settleBefore(this.#childExit, deadline);
      if (!childExit.completed) return this.#hardExitAfterTimeout("Child exit");
      exitCode = childExit.value;
    }

    const socketStop = await this.#runShutdownStage(
      "Socket stop",
      () => this.runtime.stopSocket(),
      deadline,
    );
    if (socketStop === "timeout") return this.#hardExitAfterTimeout("Socket stop");
    if (socketStop === "failed") exitCode = 1;

    const checkpoint = await this.#runShutdownStage(
      "Final checkpoint",
      () => this.runtime.checkpoint(),
      deadline,
    );
    if (checkpoint === "timeout") {
      return this.#hardExitAfterTimeout("Final checkpoint");
    }
    if (checkpoint === "failed") exitCode = 1;

    const close = await this.#runShutdownStage(
      "PGlite close",
      () => this.runtime.closeDatabase(),
      deadline,
    );
    if (close === "timeout") return this.#hardExitAfterTimeout("PGlite close");
    if (close === "failed") exitCode = 1;

    return exitCode;
  }

  async #boundedChildExit(deadline: number): Promise<SettledBefore<number>> {
    if (!this.#childExit || !this.#child) return { completed: true, value: 1 };
    const remaining = Math.max(0, deadline - Date.now());
    const gracefulDeadline = Date.now() + Math.max(1, Math.floor(remaining / 2));
    const graceful = await settleBefore(this.#childExit, gracefulDeadline);
    if (graceful.completed) return graceful;

    this.#child.kill("SIGKILL");
    return settleBefore(this.#childExit, deadline);
  }

  async #runShutdownStage(
    label: string,
    operation: () => Promise<unknown>,
    deadline: number,
  ): Promise<"complete" | "failed" | "timeout"> {
    try {
      const result = await settleBefore(Promise.resolve().then(operation), deadline);
      if (result.completed) return "complete";
      this.#dependencies.log(`${label} timed out`);
      return "timeout";
    } catch (error) {
      this.#dependencies.log(`${label} failed (${errorName(error)})`);
      return "failed";
    }
  }

  #hardExitAfterTimeout(label: string): number {
    this.#dependencies.log(`${label} exceeded the shutdown deadline`);
    this.#dependencies.hardExit(1);
    return 1;
  }
}

type SettledBefore<T> =
  | { completed: true; value: T }
  | { completed: false };

async function settleBefore<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<SettledBefore<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void promise.catch(() => undefined);
    return { completed: false };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SettledBefore<T>>((resolve) => {
    timer = setTimeout(() => resolve({ completed: false }), remaining);
  });
  const settled = promise.then<SettledBefore<T>>((value) => ({
    completed: true,
    value,
  }));
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function databaseUrls(config: SidecarConfig): {
  databaseUrl: string;
  asyncpgUrl: string;
} {
  const authority = `postgres:postgres@${config.socketHost}:${config.socketPort}`;
  return {
    databaseUrl: `postgresql://${authority}/postgres`,
    asyncpgUrl: `postgresql+asyncpg://${authority}/postgres?ssl=disable`,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown";
}
