import { runSidecar } from "./sidecar/main.js";

try {
  process.exitCode = await runSidecar();
} catch (error) {
  const name = error instanceof Error && error.name ? error.name : "unknown";
  console.error(`PGlite sidecar failed (${name})`);
  process.exitCode = 1;
}
