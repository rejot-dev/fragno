import { expect, test } from "vitest";

import { execFile, fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { GraftNodeLease } from "./graft-control-store";

const executeFile = promisify(execFile);
const authorityProcessFixture = new URL(
  "../testing/fixtures/graft-authority-runtime-process.ts",
  import.meta.url,
);
const controlProcessFixture = new URL(
  "../testing/fixtures/graft-control-store-process.ts",
  import.meta.url,
);

test("an expired owner write that lands first is preserved behind the replacement fence", async () => {
  await runAuthorityTakeoverScenario({
    ordering: "old-write-first",
    oldOutputError: "NODE_RUNTIME_OBJECT_AUTHORITY_EXPIRED",
    replacementInitialCount: 1,
    restoredCount: 6,
  });
}, 15_000);

test("a replacement fence prevents a paused expired owner from appending", async () => {
  await runAuthorityTakeoverScenario({
    ordering: "replacement-fence-first",
    oldOutputError: "NODE_RUNTIME_OBJECT_DATABASE_DURABILITY_UNCERTAIN",
    replacementInitialCount: 0,
    restoredCount: 5,
  });
}, 15_000);

type TakeoverScenarioExpectation = {
  ordering: "old-write-first" | "replacement-fence-first";
  oldOutputError: string;
  replacementInitialCount: number;
  restoredCount: number;
};

async function runAuthorityTakeoverScenario(
  expectation: TakeoverScenarioExpectation,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `graft-authority-${expectation.ordering}-`),
  );
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  let oldOwner: AuthorityRuntimeProcess | null = null;
  let replacement: AuthorityRuntimeProcess | null = null;
  let restored: AuthorityRuntimeProcess | null = null;
  try {
    const provisionConfig = await writeGraftConfig(directory, "control-provision", remoteDirectory);
    const controlRemoteLogId = await provisionControlDatabase(provisionConfig);
    await provisionObjectDatabase(
      await writeGraftConfig(directory, "object-provision", remoteDirectory),
      controlRemoteLogId,
    );

    oldOwner = await AuthorityRuntimeProcess.start({
      configPath: await writeGraftConfig(directory, "old-owner", remoteDirectory),
      controlRemoteLogId,
      nodeLease: createNodeLease("old-node", 500),
      initialTimeEpochMs: 100,
    });
    expect(oldOwner.ready).toMatchObject({
      state: { count: 0, compatibilityValue: null },
      ownership: { state: "ready", epoch: "1", ownerNodeId: "old-node" },
    });

    await oldOwner.request({ operation: "block-next-push" });
    const oldIncrement = oldOwner.request({ operation: "increment", delta: 1 });
    await oldOwner.waitForEvent("push-blocked");
    await oldOwner.request({ operation: "advance-time", milliseconds: 500 });

    if (expectation.ordering === "old-write-first") {
      await oldOwner.request({ operation: "release-push" });
      await expect(oldIncrement).rejects.toThrow(expectation.oldOutputError);
    }

    replacement = await AuthorityRuntimeProcess.start({
      configPath: await writeGraftConfig(directory, "replacement", remoteDirectory),
      controlRemoteLogId,
      nodeLease: createNodeLease("replacement-node", 1_000),
      initialTimeEpochMs: 600,
    });
    expect(replacement.ready).toMatchObject({
      state: { count: expectation.replacementInitialCount, compatibilityValue: null },
      ownership: { state: "ready", epoch: "2", ownerNodeId: "replacement-node" },
    });

    if (expectation.ordering === "replacement-fence-first") {
      await oldOwner.request({ operation: "release-push" });
      await expect(oldIncrement).rejects.toThrow(expectation.oldOutputError);
    }
    await expect(oldOwner.request({ operation: "read" })).rejects.toThrow(
      "NODE_RUNTIME_OBJECT_DATABASE_POISONED",
    );

    expect(await replacement.request({ operation: "increment", delta: 5 })).toBe(
      expectation.restoredCount,
    );
    expect(await replacement.request({ operation: "read" })).toEqual({
      count: expectation.restoredCount,
      compatibilityValue: null,
    });

    await oldOwner.cleanup();
    oldOwner = null;
    await replacement.cleanup();
    replacement = null;
    await deleteLocalGraftCaches(directory);

    restored = await AuthorityRuntimeProcess.start({
      configPath: await writeGraftConfig(directory, "restored", remoteDirectory),
      controlRemoteLogId,
      nodeLease: createNodeLease("restored-node", 2_000),
      initialTimeEpochMs: 1_100,
    });
    expect(restored.ready).toMatchObject({
      state: { count: expectation.restoredCount, compatibilityValue: null },
      ownership: { state: "ready", epoch: "3", ownerNodeId: "restored-node" },
    });
  } finally {
    await Promise.allSettled([
      oldOwner?.cleanup() ?? Promise.resolve(),
      replacement?.cleanup() ?? Promise.resolve(),
      restored?.cleanup() ?? Promise.resolve(),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
}

class AuthorityRuntimeProcess {
  ready: Record<string, unknown> = {};

  readonly #child: ChildProcess;
  readonly #responses = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly #events = new Map<string, unknown[]>();
  readonly #eventWaiters = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }[]
  >();
  #requestId = 0;
  #stderr = "";
  #closed = false;

  private constructor(child: ChildProcess) {
    this.#child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    child.on("message", (message) => this.#handleMessage(message));
    child.once("exit", (code) => this.#handleExit(code));
  }

  static async start(options: {
    configPath: string;
    controlRemoteLogId: string;
    nodeLease: GraftNodeLease;
    initialTimeEpochMs: number;
  }): Promise<AuthorityRuntimeProcess> {
    const child = fork(
      authorityProcessFixture.pathname,
      [
        "serve",
        options.configPath,
        options.controlRemoteLogId,
        JSON.stringify(options.nodeLease),
        String(options.initialTimeEpochMs),
      ],
      {
        cwd: path.dirname(authorityProcessFixture.pathname),
        execPath: process.execPath,
        execArgv: [],
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    const runtime = new AuthorityRuntimeProcess(child);
    runtime.ready = readRecord(await runtime.waitForEvent("ready"), "ready");
    return runtime;
  }

  request(command: AuthorityRuntimeCommand): Promise<unknown> {
    if (this.#closed) {
      throw new Error("GRAFT_AUTHORITY_SCENARIO_PROCESS_CLOSED");
    }
    const requestId = ++this.#requestId;
    const response = Promise.withResolvers<unknown>();
    this.#responses.set(requestId, {
      resolve: response.resolve,
      reject: response.reject,
    });
    this.#child.send({ ...command, requestId });
    return response.promise;
  }

  async waitForEvent(event: string): Promise<unknown> {
    const queued = this.#events.get(event)?.shift();
    if (queued !== undefined) {
      return queued;
    }
    return await new Promise((resolve, reject) => {
      const waiters = this.#eventWaiters.get(event) ?? [];
      waiters.push({ resolve, reject });
      this.#eventWaiters.set(event, waiters);
    });
  }

  async cleanup(): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.request({ operation: "cleanup" });
    } finally {
      this.#closed = true;
      if (this.#child.exitCode === null) {
        await new Promise<void>((resolve) => {
          this.#child.once("exit", () => resolve());
        });
      }
    }
  }

  #handleMessage(message: unknown): void {
    const record = readRecord(message, "message");
    if (record["kind"] === "response") {
      const requestId = readNumber(record, "requestId");
      const response = this.#responses.get(requestId);
      if (!response) {
        throw new Error(`GRAFT_AUTHORITY_SCENARIO_RESPONSE_MISSING:${requestId}`);
      }
      this.#responses.delete(requestId);
      if (record["outcome"] === "success") {
        response.resolve(record["value"]);
      } else {
        response.reject(new Error(readString(record, "error")));
      }
      return;
    }
    if (record["kind"] === "event") {
      const event = readString(record, "event");
      const waiter = this.#eventWaiters.get(event)?.shift();
      if (waiter) {
        waiter.resolve(record["value"]);
      } else {
        const events = this.#events.get(event) ?? [];
        events.push(record["value"]);
        this.#events.set(event, events);
      }
    }
  }

  #handleExit(code: number | null): void {
    this.#closed = true;
    const error = new Error(
      `GRAFT_AUTHORITY_SCENARIO_PROCESS_EXITED:${String(code)}:${this.#stderr}`,
    );
    for (const response of this.#responses.values()) {
      response.reject(error);
    }
    this.#responses.clear();
    for (const waiters of this.#eventWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
    this.#eventWaiters.clear();
  }
}

type AuthorityRuntimeCommand =
  | { operation: "block-next-push" }
  | { operation: "increment"; delta: number }
  | { operation: "advance-time"; milliseconds: number }
  | { operation: "release-push" }
  | { operation: "read" }
  | { operation: "ownership" }
  | { operation: "cleanup" };

function createNodeLease(nodeId: string, expiresAtMs: number): GraftNodeLease {
  return {
    nodeId,
    processGeneration: `${nodeId}-generation`,
    privateAddress: `${nodeId}.internal:8081`,
    compatibilityVersion: 1,
    expiresAtMs,
    renewalId: `${nodeId}-renewal-1`,
  };
}

async function provisionControlDatabase(configPath: string): Promise<string> {
  const { stdout } = await executeFile(
    process.execPath,
    [controlProcessFixture.pathname, "provision", configPath],
    {
      cwd: path.dirname(controlProcessFixture.pathname),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  const line = stdout.split("\n").find((entry) => entry.startsWith("GRAFT_CONTROL_STORE_RESULT:"));
  if (!line) {
    throw new Error(`GRAFT_AUTHORITY_CONTROL_PROVISION_RESULT_MISSING:${stdout}`);
  }
  const result = JSON.parse(line.slice("GRAFT_CONTROL_STORE_RESULT:".length)) as unknown;
  return readString(readRecord(result, "control provision"), "controlRemoteLogId");
}

async function provisionObjectDatabase(
  configPath: string,
  controlRemoteLogId: string,
): Promise<void> {
  await executeFile(
    process.execPath,
    [authorityProcessFixture.pathname, "provision-object", configPath, controlRemoteLogId],
    {
      cwd: path.dirname(authorityProcessFixture.pathname),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
}

async function writeGraftConfig(
  directory: string,
  name: string,
  remoteDirectory: string,
): Promise<string> {
  const cacheDirectory = path.join(directory, `${name}-cache`);
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

async function deleteLocalGraftCaches(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("-cache"))
      .map((entry) => rm(path.join(directory, entry.name), { recursive: true, force: true })),
  );
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GRAFT_AUTHORITY_SCENARIO_RECORD_INVALID:${name}`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`GRAFT_AUTHORITY_SCENARIO_STRING_INVALID:${key}`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`GRAFT_AUTHORITY_SCENARIO_NUMBER_INVALID:${key}`);
  }
  return value;
}
