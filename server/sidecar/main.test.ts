import { expect, test, vi } from "vitest";
import { runSidecar, type SidecarProcess } from "./main.js";

test("loads configuration, registers shutdown signals, and returns the child exit code", async () => {
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const sidecar: SidecarProcess = {
    start: vi.fn(async () => undefined),
    wait: vi.fn(async () => 17),
    shutdown: vi.fn(async () => 0),
  };
  const createProcess = vi.fn(() => sidecar);

  const exitCode = await runSidecar({
    environment: {
      SNAPSHOT_MODE: "filesystem",
      SNAPSHOT_DIRECTORY: ".data/snapshots",
    },
    arguments_: ["--", "uv", "run", "uvicorn", "app:app"],
    createProcess,
    onSignal: (signal, handler) => signalHandlers.set(signal, handler),
  });

  expect(exitCode).toBe(17);
  expect(createProcess).toHaveBeenCalledWith(
    expect.objectContaining({
      child: ["uv", "run", "uvicorn", "app:app"],
      socketHost: "127.0.0.1",
    }),
  );
  expect(sidecar.start).toHaveBeenCalledOnce();
  expect([...signalHandlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);

  signalHandlers.get("SIGTERM")?.();
  expect(sidecar.shutdown).toHaveBeenCalledWith("SIGTERM");
});
