import type { SidecarConfig } from "./config.js";
import { loadSidecarConfig } from "./config.js";
import { DurableSidecarRuntime } from "./runtime.js";
import { SidecarSupervisor } from "./supervisor.js";

export interface SidecarProcess {
  start(): Promise<void>;
  wait(): Promise<number>;
  shutdown(signal: NodeJS.Signals): Promise<number>;
}

interface RunSidecarOptions {
  environment?: Record<string, string | undefined>;
  arguments_?: string[];
  createProcess?: (config: SidecarConfig) => SidecarProcess;
  onSignal?: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
}

export async function runSidecar(
  options: RunSidecarOptions = {},
): Promise<number> {
  const config = loadSidecarConfig(
    options.environment ?? process.env,
    options.arguments_ ?? process.argv.slice(2),
  );
  const createProcess =
    options.createProcess ??
    ((resolved: SidecarConfig) => {
      const runtime = new DurableSidecarRuntime(resolved);
      return new SidecarSupervisor(resolved, runtime);
    });
  const sidecar = createProcess(config);
  const onSignal =
    options.onSignal ??
    ((signal: NodeJS.Signals, handler: () => void) => {
      process.once(signal, handler);
    });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    onSignal(signal, () => {
      void sidecar.shutdown(signal);
    });
  }

  await sidecar.start();
  return sidecar.wait();
}
