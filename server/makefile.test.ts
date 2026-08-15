import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Makefile deployment workflow", () => {
  it("does not execute Databricks commands during a deploy-run dry-run", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "pglite-make-"));
    temporaryDirectories.push(temporaryDirectory);

    const binaryDirectory = join(temporaryDirectory, "bin");
    const callLog = join(temporaryDirectory, "databricks-calls.log");
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(callLog, "", "utf8");

    const databricksStub = join(binaryDirectory, "databricks");
    await writeFile(
      databricksStub,
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MAKE_TEST_CALL_LOG"\n',
      "utf8",
    );
    await chmod(databricksStub, 0o755);

    const result = spawnSync(
      "make",
      ["-n", "deploy-run", "PROFILE=DEFAULT", "TARGET=dev"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          MAKEFLAGS: "",
          MAKE_TEST_CALL_LOG: callLog,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(callLog, "utf8")).toBe("");
    expect(result.stdout).toContain("databricks bundle deploy -t dev -p DEFAULT");
    expect(result.stdout).toContain("databricks bundle run pglite_app -t dev -p DEFAULT");
  });
});
