import { expect, test } from "vitest";

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const processFixture = new URL("../testing/fixtures/graft-runtime-process.ts", import.meta.url);

type GraftRuntimeProcessCommand =
  | "provision"
  | "write"
  | "read"
  | "push-counts"
  | "output-gate-push-counts"
  | "write-then-throw"
  | "write-failure";

test("a fresh container restores object SQL and compatibility state after losing its local cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-runtime-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  try {
    const provision = await runGraftRuntimeProcess(
      "provision",
      await writeGraftConfig(directory, "provision", remoteDirectory),
    );
    const controlRemoteLogId = readString(provision, "controlRemoteLogId");

    const firstCache = path.join(directory, "first-cache");
    const first = await runGraftRuntimeProcess(
      "write",
      await writeGraftConfig(directory, "first", remoteDirectory, firstCache),
      controlRemoteLogId,
    );
    expect(first).toEqual({
      count: 3,
      state: { count: 3, compatibilityValue: "remote state" },
    });

    await rm(firstCache, { recursive: true, force: true });

    const restored = await runGraftRuntimeProcess(
      "read",
      await writeGraftConfig(directory, "restored", remoteDirectory),
      controlRemoteLogId,
    );
    expect(restored).toEqual({
      state: { count: 3, compatibilityValue: "remote state" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct RPC outputs push separately outside an external output gate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-runtime-push-counts-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  try {
    const provision = await runGraftRuntimeProcess(
      "provision",
      await writeGraftConfig(directory, "provision", remoteDirectory),
    );
    const controlRemoteLogId = readString(provision, "controlRemoteLogId");
    const result = await runGraftRuntimeProcess(
      "push-counts",
      await writeGraftConfig(directory, "runtime", remoteDirectory),
      controlRemoteLogId,
    );
    expect(result).toEqual({
      singleRpcCount: 3,
      singleRpcPushes: 1,
      multipleRpcCount: 6,
      multipleRpcPushes: 3,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an external output gate batches separate RPCs and releases readers after one push", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-runtime-output-gate-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  try {
    const provision = await runGraftRuntimeProcess(
      "provision",
      await writeGraftConfig(directory, "provision", remoteDirectory),
    );
    const controlRemoteLogId = readString(provision, "controlRemoteLogId");
    const result = await runGraftRuntimeProcess(
      "output-gate-push-counts",
      await writeGraftConfig(directory, "runtime", remoteDirectory),
      controlRemoteLogId,
    );
    expect(result).toEqual({
      scopedCount: 3,
      pushesBeforeOutput: 0,
      pushesAfterOutput: 1,
      secondRequestState: { count: 4, compatibilityValue: null },
      firstRequestCount: 4,
      pushesAfterSecondRequest: 1,
      pushesAfterFirstRequest: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the worker pushes local commits before returning a handler error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-runtime-error-gate-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  try {
    const provision = await runGraftRuntimeProcess(
      "provision",
      await writeGraftConfig(directory, "provision", remoteDirectory),
    );
    const controlRemoteLogId = readString(provision, "controlRemoteLogId");
    const result = await runGraftRuntimeProcess(
      "write-then-throw",
      await writeGraftConfig(directory, "writer", remoteDirectory),
      controlRemoteLogId,
    );
    expect(result).toEqual({ error: "EXPECTED_GRAFT_COUNTER_FAILURE" });

    const restored = await runGraftRuntimeProcess(
      "read",
      await writeGraftConfig(directory, "restored", remoteDirectory),
      controlRemoteLogId,
    );
    expect(restored).toEqual({ state: { count: 2, compatibilityValue: null } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a returned capability cannot report success after its Graft push fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-runtime-failure-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  try {
    const provision = await runGraftRuntimeProcess(
      "provision",
      await writeGraftConfig(directory, "provision", remoteDirectory),
    );
    const controlRemoteLogId = readString(provision, "controlRemoteLogId");
    const result = await runGraftRuntimeProcess(
      "write-failure",
      await writeGraftConfig(directory, "writer", remoteDirectory),
      controlRemoteLogId,
      remoteDirectory,
    );
    expect(result).toEqual({
      writeError: "NODE_RUNTIME_OBJECT_DATABASE_DURABILITY_UNCERTAIN",
      readError: "NODE_RUNTIME_OBJECT_DATABASE_POISONED",
    });

    const restored = await runGraftRuntimeProcess(
      "read",
      await writeGraftConfig(directory, "restored", remoteDirectory),
      controlRemoteLogId,
    );
    expect(restored).toEqual({ state: { count: 0, compatibilityValue: null } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function writeGraftConfig(
  directory: string,
  name: string,
  remoteDirectory: string,
  cacheDirectory = path.join(directory, `${name}-cache`),
): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true });
  const configPath = path.join(directory, `${name}.toml`);
  await writeFile(
    configPath,
    [
      `data_dir = ${JSON.stringify(cacheDirectory)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(remoteDirectory)}`,
      "",
    ].join("\n"),
  );
  return configPath;
}

async function runGraftRuntimeProcess(
  command: GraftRuntimeProcessCommand,
  configPath: string,
  controlRemoteLogId?: string,
  remoteDirectory?: string,
): Promise<Record<string, unknown>> {
  const arguments_ = [processFixture.pathname, command, configPath];
  if (controlRemoteLogId) {
    arguments_.push(controlRemoteLogId);
  }
  if (remoteDirectory) {
    arguments_.push(remoteDirectory);
  }
  const { stdout } = await executeFile(process.execPath, arguments_, {
    cwd: path.dirname(processFixture.pathname),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const resultLine = stdout.split("\n").find((line) => line.startsWith("GRAFT_RUNTIME_RESULT:"));
  if (!resultLine) {
    throw new Error(`GRAFT_RUNTIME_PROCESS_RESULT_MISSING:${stdout}`);
  }
  const result = JSON.parse(resultLine.slice("GRAFT_RUNTIME_RESULT:".length)) as unknown;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("GRAFT_RUNTIME_PROCESS_RESULT_INVALID");
  }
  return result as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`GRAFT_RUNTIME_PROCESS_STRING_MISSING:${key}`);
  }
  return value;
}
