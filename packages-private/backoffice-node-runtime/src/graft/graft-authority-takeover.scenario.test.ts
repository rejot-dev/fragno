import { assert, expect, test } from "vitest";

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

test("the first authority-bound operation lazily provisions and activates its object", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-authority-lazy-provisioning-"));
  const remoteDirectory = path.join(directory, "remote");
  await mkdir(remoteDirectory);
  let owner: AuthorityRuntimeProcess | null = null;
  try {
    const controlRemoteLogId = await provisionControlDatabase(
      await writeGraftConfig(directory, "control-provision", remoteDirectory),
    );
    owner = await AuthorityRuntimeProcess.start({
      configPath: await writeGraftConfig(directory, "lazy-owner", remoteDirectory),
      controlRemoteLogId,
      nodeLease: createNodeLease("lazy-owner", 500),
      initialTimeEpochMs: 100,
    });
    expect(owner.ready).toMatchObject({
      state: { count: 0, compatibilityValue: null },
      ownership: {
        state: "ready",
        objectId: "COUNTER:one",
        epoch: "1",
        ownerNodeId: "lazy-owner",
      },
    });
  } finally {
    await owner?.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("an expired owner write that lands first is preserved behind the replacement fence", async () => {
  await runAuthorityTakeoverScenario({
    ordering: "old-write-first",
    oldOutputError: "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    replacementInitialCount: 1,
    restoredCount: 6,
  });
}, 15_000);

test("a replacement fence prevents a paused expired owner from appending", async () => {
  await runAuthorityTakeoverScenario({
    ordering: "replacement-fence-first",
    oldOutputError: "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    replacementInitialCount: 0,
    restoredCount: 5,
  });
}, 15_000);

test("confirmed renewal reaches active workers and healthy cleanup releases the exact claim", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("renewing-owner", 100, 500);
    await owner.request({ operation: "advance-time", milliseconds: 150 });
    expect(await owner.request({ operation: "tick-runtime" })).toMatchObject({
      state: "serving",
      window: { leaseExpiresAtEpochMs: 650, selfFenceAtMonotonicMs: 550 },
    });
    // Renewal does not await worker acknowledgements; cross the worker channel before advancing time.
    assert.equal(await owner.request({ operation: "in-memory" }), "counter-instance");
    await owner.request({ operation: "advance-time", milliseconds: 300 });
    assert.equal(await owner.request({ operation: "in-memory" }), "counter-instance");
    assert.equal(await owner.request({ operation: "capability-increment", delta: 2 }), 2);
    await owner.cleanup();
    const replacement = await start("immediate-replacement", 550, 950);
    expect(replacement.ready).toMatchObject({
      state: { count: 2 },
      ownership: { state: "ready", epoch: "2", ownerNodeId: "immediate-replacement" },
    });
    // The replacement claimed before the prior durable lease expired; cleanup had to release it.
  });
}, 15_000);

test("a blocked object push does not prevent subsequent node lease renewals", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("blocked-worker-renewal", 100, 1_100);
    await owner.request({ operation: "block-next-push" });
    const increment = owner.request({ operation: "increment", delta: 1 });
    const pending: Promise<unknown>[] = [increment];
    void increment.catch(() => {});
    try {
      await owner.waitForEvent("push-blocked");
      await owner.request({ operation: "advance-time", milliseconds: 150 });
      const firstTick = owner.request({ operation: "tick-runtime" });
      pending.push(firstTick);
      void firstTick.catch(() => {});
      expect(await owner.request({ operation: "authority-status" })).toMatchObject({
        state: "serving",
        window: { leaseExpiresAtEpochMs: 1_250 },
      });

      await owner.request({ operation: "advance-time", milliseconds: 150 });
      const secondTick = owner.request({ operation: "tick-runtime" });
      pending.push(secondTick);
      void secondTick.catch(() => {});
      await expect
        .poll(() => owner.request({ operation: "authority-status" }), {
          timeout: 1_000,
          message: "A worker that cannot acknowledge renewal must not hold up the next lease",
        })
        .toMatchObject({
          state: "serving",
          window: { leaseExpiresAtEpochMs: 1_400 },
        });

      await owner.request({ operation: "release-push" });
      assert.equal(await increment, 1);
      // The push result precedes the queued extension. A following worker RPC is the delivery
      // barrier before jumping past the original lease; the next RPC covers the coalesced window.
      assert.equal(await owner.request({ operation: "in-memory" }), "counter-instance");
      await owner.request({ operation: "advance-time", milliseconds: 700 });
      assert.equal(await owner.request({ operation: "in-memory" }), "counter-instance");
      // Cross the first extension's expiry without another tick: the queued latest window must apply.
      await owner.request({ operation: "advance-time", milliseconds: 200 });
      assert.equal(await owner.request({ operation: "capability-increment", delta: 1 }), 2);
    } finally {
      await owner.request({ operation: "release-push" });
      await Promise.allSettled(pending);
    }
  });
}, 15_000);

test("a worker missing its authority window stays fenced while a healthy sibling keeps serving", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("isolated-worker-expiry", 100, 1_100);
    assert.equal(
      await owner.request({ operation: "increment-object", name: "healthy", delta: 1 }),
      1,
    );
    await owner.request({ operation: "block-next-push" });
    const increment = owner.request({ operation: "increment", delta: 1 });
    void increment.catch(() => {});
    try {
      await owner.waitForEvent("push-blocked");
      for (let renewal = 1; renewal <= 7; renewal += 1) {
        await owner.request({ operation: "advance-time", milliseconds: 150 });
        expect(await owner.request({ operation: "tick-runtime" })).toMatchObject({
          state: "serving",
          window: { leaseExpiresAtEpochMs: 1_100 + renewal * 150 },
        });
        assert.equal(
          await owner.request({ operation: "increment-object", name: "healthy", delta: 1 }),
          1 + renewal,
        );
      }

      await owner.request({ operation: "release-push" });
      await expect(increment).rejects.toThrow(
        /NODE_RUNTIME_OBJECT_AUTHORITY_EXPIRED|NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED/,
      );
      await expect(owner.request({ operation: "in-memory" })).rejects.toThrow(
        "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
      );
      await expect(owner.request({ operation: "capability-increment", delta: 1 })).rejects.toThrow(
        "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
      );
      expect(await owner.request({ operation: "authority-status" })).toMatchObject({
        state: "serving",
        window: { leaseExpiresAtEpochMs: 2_150 },
      });
      assert.equal(
        await owner.request({ operation: "increment-object", name: "healthy", delta: 1 }),
        9,
      );
    } finally {
      await owner.request({ operation: "release-push" });
      await Promise.allSettled([increment]);
    }
  });
}, 15_000);

test("suspension self-fences pure RPC and retained capabilities despite wall-clock rollback", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("suspended-owner", 100, 500);
    await owner.request({ operation: "set-wall-time", epochMilliseconds: 0 });
    await owner.request({ operation: "advance-monotonic-time", milliseconds: 400 });
    await expect(owner.request({ operation: "in-memory" })).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    );
    expect(await owner.request({ operation: "authority-status" })).toMatchObject({
      state: "fenced",
    });
    await expect(owner.request({ operation: "capability-increment", delta: 1 })).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    );
    await expect(owner.request({ operation: "fresh-read" })).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
    );
    expect(await owner.request({ operation: "ownership" })).toMatchObject({
      state: "ready",
      epoch: "1",
    });
    await owner.cleanup();
    const replacement = await start("after-suspension", 600, 1_000);
    expect(replacement.ready).toMatchObject({ state: { count: 0 }, ownership: { epoch: "2" } });
  });
}, 15_000);

test("an empty external output gate cannot escape across the process authority deadline", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("empty-output-owner", 100, 500);
    await expect(
      owner.request({ operation: "expire-empty-output", milliseconds: 400 }),
    ).rejects.toThrow("NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED");
    expect(await owner.request({ operation: "authority-status" })).toMatchObject({
      state: "fenced",
    });
  });
}, 15_000);

test("a crash before the object push leaves repair work but does not invent an alarm", async () => {
  await runNodeLifecycleScenario(async ({ start, deleteLocalCaches }) => {
    const owner = await start("alarm-precommit-owner", 100, 500);
    await owner.request({ operation: "block-next-push" });
    const scheduling = owner.request({ operation: "schedule-alarm", timestamp: 700 });
    const schedulingFailure = expect(scheduling).rejects.toThrow(
      "GRAFT_AUTHORITY_SCENARIO_PROCESS_EXITED",
    );
    await owner.waitForEvent("push-blocked");
    await owner.hardKill();
    await schedulingFailure;
    await deleteLocalCaches();

    const replacement = await start("alarm-precommit-replacement", 700, 1_200);
    await replacement.request({ operation: "tick-runtime" });
    expect(await replacement.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: null,
      deliveryCount: 0,
    });
  });
}, 15_000);

test("a crash after the object push repairs discovery and delivers the durable alarm", async () => {
  await runNodeLifecycleScenario(async ({ start, deleteLocalCaches }) => {
    const owner = await start("alarm-postcommit-owner", 100, 500);
    await owner.request({ operation: "block-next-push-after-commit" });
    const scheduling = owner.request({ operation: "schedule-alarm", timestamp: 700 });
    const schedulingFailure = expect(scheduling).rejects.toThrow(
      "GRAFT_AUTHORITY_SCENARIO_PROCESS_EXITED",
    );
    await owner.waitForEvent("push-blocked");
    await owner.hardKill();
    await schedulingFailure;
    await deleteLocalCaches();

    const replacement = await start("alarm-postcommit-replacement", 700, 1_200);
    expect(await replacement.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: 700,
      deliveryCount: 0,
    });
    await replacement.request({ operation: "tick-runtime" });
    expect(await replacement.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: null,
      deliveryCount: 1,
    });
  });
}, 15_000);

test("a fresh node discovers and delivers an alarm after every local cache is deleted", async () => {
  await runNodeLifecycleScenario(async ({ start, deleteLocalCaches }) => {
    const owner = await start("alarm-owner", 100, 500);
    expect(await owner.request({ operation: "schedule-alarm", timestamp: 700 })).toEqual({
      scheduledAt: 700,
      deliveryCount: 0,
    });
    await owner.cleanup();
    await deleteLocalCaches();

    const replacement = await start("alarm-replacement", 700, 1_200);
    await replacement.request({ operation: "tick-runtime" });
    expect(await replacement.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: null,
      deliveryCount: 1,
    });
  });
}, 15_000);

test("a same-timestamp handler rearm survives completion of the delivered installation", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("alarm-rearm-owner", 100, 1_000);
    await owner.request({ operation: "rearm-on-next-alarm", timestamp: 100 });
    await owner.request({ operation: "schedule-alarm", timestamp: 100 });

    await owner.request({ operation: "tick-runtime" });
    expect(await owner.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: 100,
      deliveryCount: 1,
    });

    await owner.request({ operation: "tick-runtime" });
    expect(await owner.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: null,
      deliveryCount: 2,
    });
  });
}, 15_000);

test("a failed alarm remains discoverable and is retried on the next tick", async () => {
  await runNodeLifecycleScenario(async ({ start }) => {
    const owner = await start("alarm-retry-owner", 100, 1_000);
    await owner.request({ operation: "fail-next-alarm" });
    await owner.request({ operation: "schedule-alarm", timestamp: 100 });

    await expect(owner.request({ operation: "tick-runtime" })).rejects.toThrow(
      "NODE_OBJECT_RUNTIME_ALARM_DELIVERY_FAILED",
    );
    expect(await owner.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: 100,
      deliveryCount: 1,
    });

    await owner.request({ operation: "tick-runtime" });
    expect(await owner.request({ operation: "alarm-state" })).toEqual({
      scheduledAt: null,
      deliveryCount: 2,
    });
  });
}, 15_000);

async function runNodeLifecycleScenario(
  operation: (context: {
    start(
      nodeId: string,
      initialTimeEpochMs: number,
      expiresAtMs: number,
    ): Promise<AuthorityRuntimeProcess>;
    deleteLocalCaches(): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-lifecycle-"));
  const remoteDirectory = path.join(directory, "remote");
  const processes: AuthorityRuntimeProcess[] = [];
  await mkdir(remoteDirectory);
  try {
    const controlRemoteLogId = await provisionControlDatabase(
      await writeGraftConfig(directory, "control-provision", remoteDirectory),
    );
    await provisionObjectDatabase(
      await writeGraftConfig(directory, "object-provision", remoteDirectory),
      controlRemoteLogId,
    );
    await operation({
      async start(nodeId, initialTimeEpochMs, expiresAtMs) {
        const process = await AuthorityRuntimeProcess.start({
          configPath: await writeGraftConfig(directory, nodeId, remoteDirectory),
          controlRemoteLogId,
          nodeLease: createNodeLease(nodeId, expiresAtMs),
          initialTimeEpochMs,
        });
        processes.push(process);
        return process;
      },
      async deleteLocalCaches() {
        await deleteLocalGraftCaches(directory);
      },
    });
  } finally {
    await Promise.allSettled(processes.map((process) => process.cleanup()));
    await rm(directory, { recursive: true, force: true });
  }
}

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
      "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
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

  async hardKill(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#child.kill("SIGKILL");
    if (this.#child.exitCode === null) {
      await new Promise<void>((resolve) => {
        this.#child.once("exit", () => resolve());
      });
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
  | { operation: "block-next-push-after-commit" }
  | { operation: "increment"; delta: number }
  | { operation: "increment-object"; name: string; delta: number }
  | { operation: "advance-time"; milliseconds: number }
  | { operation: "advance-monotonic-time"; milliseconds: number }
  | { operation: "set-wall-time"; epochMilliseconds: number }
  | { operation: "tick-runtime" }
  | { operation: "authority-status" }
  | { operation: "in-memory" }
  | { operation: "capability-increment"; delta: number }
  | { operation: "fresh-read" }
  | { operation: "expire-empty-output"; milliseconds: number }
  | { operation: "release-push" }
  | { operation: "schedule-alarm"; timestamp: number }
  | { operation: "cancel-alarm" }
  | { operation: "rearm-on-next-alarm"; timestamp: number }
  | { operation: "fail-next-alarm" }
  | { operation: "alarm-state" }
  | { operation: "read" }
  | { operation: "ownership" }
  | { operation: "cleanup" };

function createNodeLease(nodeId: string, expiresAtMs: number): GraftNodeLease {
  return {
    nodeId,
    processGeneration: `${nodeId}-generation`,
    privateAddress: `ws://${nodeId}.internal:8081/node-object-peer`,
    applicationOrigin: `http://${nodeId}.internal:8081`,
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
