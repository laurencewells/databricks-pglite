import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Python example project", () => {
  it("runs its pinned backend tests", () => {
    const result = spawnSync(
      "uv",
      [
        "run",
        "--project",
        "examples/python",
        "--extra",
        "test",
        "pytest",
        "-q",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(result.stdout).toContain("5 passed");
  }, 60_000);
});
