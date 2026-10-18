import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { GraftNodeRuntimeStorage } from "@fragno-private/backoffice-node-runtime/graft-runtime-storage";
import {
  createRuntimeScenarioStepBuilders,
  runRuntimeScenarioSteps,
} from "@fragno-private/backoffice-node-runtime/runtime-scenario";

const executeFile = promisify(execFile);
let directory: string;
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "backoffice-local-graft-")));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function runGraftStorageProcess(
  workingDirectory: string,
  operation: "read" | "reserve",
  overrides: Record<string, string>,
): Promise<GraftNodeRuntimeStorage> {
  // Graft registers one VFS configuration per process; restarts use real, isolated Node processes.
  const environmentOverrides: Record<string, string> = {
    NODE_ENV: "development",
    GRAFT_CONFIG: "",
    BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID: "",
    ...overrides,
  };
  const { stdout } = await executeFile(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/node-graft-storage-process.mts", import.meta.url)),
      operation,
    ],
    { cwd: workingDirectory, env: { ...process.env, ...environmentOverrides } },
  );
  return JSON.parse(stdout) as GraftNodeRuntimeStorage;
}

async function seedLocalGraftConfig(workingDirectory: string): Promise<void> {
  const root = path.join(workingDirectory, ".backoffice-graft");
  const cache = path.join(root, "cache");
  const remote = path.join(root, "remote");
  await Promise.all([mkdir(cache, { recursive: true }), mkdir(remote, { recursive: true })]);
  await writeFile(
    path.join(root, "graft.toml"),
    [
      `data_dir = ${JSON.stringify(cache)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(remote)}`,
      "",
    ].join("\n"),
  );
}

test("default local Graft storage publishes once and recovers the same control history without its cache", async () => {
  const root = await mkdtemp(path.join(directory, "restart-"));
  let original: GraftNodeRuntimeStorage;
  let remoteEntries: string[];
  const { when, then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
  await runRuntimeScenarioSteps({
    name: "first development run and cache-free restart",
    context: null,
    stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
    steps: [
      when("start without Graft configuration", async () => {
        original = await runGraftStorageProcess(root, "read", {});
        remoteEntries = await readdir(path.join(root, ".backoffice-graft/remote"));
        expect(remoteEntries.length).toBeGreaterThan(0);
        expect(
          (await readFile(path.join(root, ".backoffice-graft/control-log-id"), "utf8")).trim(),
        ).toBe(original.controlRemoteLogId);
      }),
      when("discard the cache and start another process", async () => {
        await rm(path.join(root, ".backoffice-graft/cache"), { recursive: true });
      }),
      then("the published control log and locator are unchanged", async () => {
        expect(await runGraftStorageProcess(root, "read", {})).toEqual(original);
        expect(await readdir(path.join(root, ".backoffice-graft/remote"))).toEqual(remoteEntries);
      }),
    ],
  });
});

test("an interrupted first run publishes its reserved control log instead of reserving a replacement", async () => {
  const root = await mkdtemp(path.join(directory, "interrupted-"));
  await seedLocalGraftConfig(root);
  let reserved: GraftNodeRuntimeStorage;
  const { when, then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
  await runRuntimeScenarioSteps({
    name: "resume a persisted reservation before first publication",
    context: null,
    stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
    steps: [
      when("exit after persisting the reserved ID", async () => {
        reserved = await runGraftStorageProcess(root, "reserve", {});
        expect(await readdir(path.join(root, ".backoffice-graft/remote"))).toEqual([]);
      }),
      then("startup publishes and verifies that same identity", async () => {
        expect(await runGraftStorageProcess(root, "read", {})).toEqual(reserved);
        expect(
          (await readFile(path.join(root, ".backoffice-graft/control-log-id"), "utf8")).trim(),
        ).toBe(reserved.controlRemoteLogId);
        expect((await readdir(path.join(root, ".backoffice-graft/remote"))).length).toBeGreaterThan(
          0,
        );
      }),
    ],
  });
});

test.each(["missing", "empty"] as const)(
  "local history with a %s locator cannot silently become a new store",
  async (state) => {
    const root = await mkdtemp(path.join(directory, "lost-locator-"));
    const original = await runGraftStorageProcess(root, "read", {});
    const marker = path.join(root, ".backoffice-graft/control-log-id");
    const remote = path.join(root, ".backoffice-graft/remote");
    const remoteEntries = await readdir(remote);
    const { when, then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
    await runRuntimeScenarioSteps({
      name: `refuse a ${state} local locator`,
      context: null,
      stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
      steps: [
        when("lose the original locator", async () => {
          if (state === "missing") {
            await unlink(marker);
          } else {
            await writeFile(marker, "\n");
          }
        }),
        then("startup refuses to reserve a replacement", async () => {
          await expect(runGraftStorageProcess(root, "read", {})).rejects.toThrow(
            state === "missing"
              ? "BACKOFFICE_LOCAL_GRAFT_CONTROL_LOG_ID_MISSING"
              : "BACKOFFICE_LOCAL_GRAFT_CONTROL_LOG_ID_EMPTY",
          );
          expect(await readdir(remote)).toEqual(remoteEntries);
        }),
        then(
          "an explicit ID can recover the original history without overwriting the locator",
          async () => {
            expect(
              await runGraftStorageProcess(root, "read", {
                BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID: original.controlRemoteLogId,
              }),
            ).toEqual(original);
            if (state === "empty") {
              assert((await readFile(marker, "utf8")) === "\n");
            } else {
              await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
            }
          },
        ),
      ],
    });
  },
);

test.each<{ name: string; overrides: Record<string, string> }>([
  { name: "production", overrides: { NODE_ENV: "production" } },
  { name: "custom development config", overrides: { GRAFT_CONFIG: "custom-graft.toml" } },
  { name: "unset environment", overrides: { NODE_ENV: "" } },
])("$name still requires an explicitly published ID", async ({ name, overrides }) => {
  const root = await mkdtemp(path.join(directory, "strict-"));
  const { then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
  await runRuntimeScenarioSteps({
    name: `strict storage configuration for ${name}`,
    context: null,
    stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
    steps: [
      then("startup fails without creating local storage", async () => {
        await expect(runGraftStorageProcess(root, "read", overrides)).rejects.toThrow(
          "BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID_REQUIRED",
        );
        expect(await readdir(root)).toEqual([]);
      }),
    ],
  });
});

test("a working-directory Graft config is not silently replaced by the development default", async () => {
  const root = await mkdtemp(path.join(directory, "existing-config-"));
  await writeFile(path.join(root, "graft.toml"), 'data_dir = "/existing/cache"\n');
  const { then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
  await runRuntimeScenarioSteps({
    name: "retain existing explicit configuration",
    context: null,
    stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
    steps: [
      then("the existing config requires its published ID", async () => {
        await expect(runGraftStorageProcess(root, "read", {})).rejects.toThrow(
          "BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID_REQUIRED",
        );
        expect(await readdir(root)).toEqual(["graft.toml"]);
      }),
    ],
  });
});

test("editing the generated config requires explicitly selecting that config and its control log", async () => {
  const root = await mkdtemp(path.join(directory, "changed-config-"));
  const original = await runGraftStorageProcess(root, "read", {});
  const configuration = await readFile(original.configPath, "utf8");
  await writeFile(original.configPath, `${configuration}# Custom configuration\n`);
  const { then } = createRuntimeScenarioStepBuilders<null>("LOCAL_GRAFT_SCENARIO_FAILED");
  await runRuntimeScenarioSteps({
    name: "custom storage remains an explicit choice",
    context: null,
    stepFailurePrefix: "LOCAL_GRAFT_SCENARIO_STEP_FAILED",
    steps: [
      then("automatic startup refuses the edited default", async () => {
        await expect(runGraftStorageProcess(root, "read", {})).rejects.toThrow(
          "BACKOFFICE_LOCAL_GRAFT_CONFIG_CHANGED",
        );
      }),
      then("explicit configuration can still recover the same real control log", async () => {
        expect(
          await runGraftStorageProcess(root, "read", {
            GRAFT_CONFIG: original.configPath,
            BACKOFFICE_GRAFT_CONTROL_REMOTE_LOG_ID: original.controlRemoteLogId,
          }),
        ).toEqual(original);
      }),
    ],
  });
});
