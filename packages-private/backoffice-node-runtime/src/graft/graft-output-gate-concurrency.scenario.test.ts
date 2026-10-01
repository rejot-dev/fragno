import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { defineGraftDatabaseOperations } from "@fragno-private/backoffice-node-runtime/graft-database-operations";
import { provisionGraftControlDatabase } from "@fragno-private/backoffice-node-runtime/graft-object-directory";
import { createGraftNodeObjectRuntimeWithDatabaseOperations } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createGraftCounterObject } from "../testing/fixtures/graft-runtime.objects";
import {
  createRuntimeScenarioStepBuilders,
  runRuntimeScenarioSteps,
  type RuntimeScenarioStep,
  type RuntimeScenarioStepBuilders,
} from "../testing/runtime-scenario";

const executeFile = promisify(execFile);
const processFixture = new URL("../testing/fixtures/graft-runtime-process.ts", import.meta.url);
const counterDefinition = defineNodeRuntimeObject<typeof createGraftCounterObject>(
  new URL("../testing/fixtures/graft-runtime.objects.ts", import.meta.url),
  "createGraftCounterObject",
);
const FAIL_NEXT_PUSH_BEFORE_REMOTE_COMMIT = 1;
const LOSE_NEXT_PUSH_RESPONSE_AFTER_REMOTE_COMMIT = 2;

let scenarioDirectory: string;
let scenarioConfigPath: string;
let scenarioRemoteDirectory: string;

beforeAll(async () => {
  scenarioDirectory = await mkdtemp(path.join(os.tmpdir(), "graft-output-gate-scenarios-"));
  scenarioRemoteDirectory = path.join(scenarioDirectory, "remote");
  const cacheDirectory = path.join(scenarioDirectory, "cache");
  await Promise.all([mkdir(scenarioRemoteDirectory), mkdir(cacheDirectory)]);
  scenarioConfigPath = path.join(scenarioDirectory, "graft.toml");
  await writeGraftConfig(scenarioConfigPath, cacheDirectory);
});

afterAll(async () => {
  await rm(scenarioDirectory, { recursive: true, force: true });
});

type GraftCounterRuntime = ReturnType<typeof createGraftCounterRuntime>;
type GraftCounterStub = ReturnType<GraftCounterRuntime["objects"]["COUNTER"]["get"]>;
type GraftCounterCapability = Awaited<ReturnType<GraftCounterStub["operationCapability"]>>;
type GraftCounterState = { count: number; compatibilityValue: string | null };
type GraftCounterScenarioContext = {
  counter: GraftCounterRuntime["objects"]["COUNTER"];
  output: { run<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> };
  pushes: {
    count(): number;
    failNextBeforeRemoteCommit(): void;
    loseNextResponseAfterRemoteCommit(): void;
  };
};

type GraftCounterScenarioDefinition = {
  name: string;
  steps(
    builders: RuntimeScenarioStepBuilders<GraftCounterScenarioContext>,
  ): readonly RuntimeScenarioStep<GraftCounterScenarioContext>[];
};

test("concurrent RPCs in one output scope share one durability push", async () => {
  let counts: number[] = [];
  let pushesBeforeOutput = -1;

  await runGraftCounterScenario({
    name: "concurrent RPCs in one output scope",
    steps: ({ given, when, then }) => [
      given("a durable counter with no pending push", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("one request dispatches three increment RPCs concurrently", async (context) => {
        counts = await context.output.run(async () => {
          using counter = context.counter.get("one");
          const results = await Promise.all([
            counter.increment(1),
            counter.increment(1),
            counter.increment(1),
          ]);
          pushesBeforeOutput = context.pushes.count();
          return results.sort((left, right) => left - right);
        });
      }),
      then("the RPC results expose all three local commits", () => {
        expect(counts).toEqual([1, 2, 3]);
      }),
      then("no push occurs between the concurrent RPC results", () => {
        assert.equal(pushesBeforeOutput, 0);
      }),
      then("the external output boundary performs one push", ({ pushes }) => {
        assert.equal(pushes.count(), 1);
      }),
    ],
  });
});

test("concurrent writer scopes share the push that precedes their outputs", async () => {
  const firstCommitted = Promise.withResolvers<void>();
  const secondCommitted = Promise.withResolvers<void>();
  const releaseOutputs = Promise.withResolvers<void>();
  let counts: number[] = [];
  let pushesBeforeOutput = -1;

  await runGraftCounterScenario({
    name: "concurrent writer output scopes",
    steps: ({ given, when, then }) => [
      given("two requests whose outputs can be held independently", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("both requests commit before either output is released", async (context) => {
        const firstWriter = context.output.run(async () => {
          using counter = context.counter.get("one");
          const count = await counter.increment(1);
          firstCommitted.resolve();
          await releaseOutputs.promise;
          return count;
        });
        const secondWriter = context.output.run(async () => {
          using counter = context.counter.get("one");
          const count = await counter.increment(1);
          secondCommitted.resolve();
          await releaseOutputs.promise;
          return count;
        });

        await Promise.all([firstCommitted.promise, secondCommitted.promise]);
        pushesBeforeOutput = context.pushes.count();
        releaseOutputs.resolve();
        counts = (await Promise.all([firstWriter, secondWriter])).sort(
          (left, right) => left - right,
        );
      }),
      then("both writers completed their local commits", () => {
        expect(counts).toEqual([1, 2]);
      }),
      then("neither request pushed before its output was released", () => {
        assert.equal(pushesBeforeOutput, 0);
      }),
      then("one push covers both output scopes", ({ pushes }) => {
        assert.equal(pushes.count(), 1);
      }),
    ],
  });
});

test("a reader does not wait for a later storage position it did not observe", async () => {
  const readerObserved = Promise.withResolvers<void>();
  const releaseReader = Promise.withResolvers<void>();
  const writerCommitted = Promise.withResolvers<void>();
  const releaseWriter = Promise.withResolvers<void>();
  let readerState: GraftCounterState | null = null;
  let writerCount = -1;
  let pushesAfterReader = -1;
  let pushesAfterWriter = -1;

  await runGraftCounterScenario({
    name: "reader completes before a later writer",
    steps: ({ given, when, then }) => [
      given("a reader that has observed the durable position", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("a writer commits only after the reader has finished reading", async (context) => {
        const reader = context.output.run(async () => {
          using counter = context.counter.get("one");
          const state = await counter.read();
          readerObserved.resolve();
          await releaseReader.promise;
          return state;
        });
        await readerObserved.promise;

        const writer = context.output.run(async () => {
          using counter = context.counter.get("one");
          const count = await counter.increment(1);
          writerCommitted.resolve();
          await releaseWriter.promise;
          return count;
        });
        await writerCommitted.promise;

        releaseReader.resolve();
        readerState = await reader;
        pushesAfterReader = context.pushes.count();
        releaseWriter.resolve();
        writerCount = await writer;
        pushesAfterWriter = context.pushes.count();
      }),
      then("the reader returns only the position it observed", () => {
        expect(readerState).toEqual({ count: 0, compatibilityValue: null });
      }),
      then("the reader does not push the later writer position", () => {
        assert.equal(pushesAfterReader, 0);
      }),
      then("the writer pushes its position before exposing output", () => {
        assert.equal(writerCount, 1);
        assert.equal(pushesAfterWriter, 1);
      }),
    ],
  });
});

test("outputs released at different storage positions require separate pushes", async () => {
  let firstCount = -1;
  let secondCount = -1;
  let pushesAfterFirstOutput = -1;
  let pushesAfterSecondOutput = -1;

  await runGraftCounterScenario({
    name: "sequential output positions",
    steps: ({ given, when, then }) => [
      given("a durable counter with no pending push", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("the first request commits and releases its output", async (context) => {
        firstCount = await context.output.run(async () => {
          using counter = context.counter.get("one");
          return await counter.increment(1);
        });
        pushesAfterFirstOutput = context.pushes.count();
      }),
      when("a second request commits only after the first output was released", async (context) => {
        secondCount = await context.output.run(async () => {
          using counter = context.counter.get("one");
          return await counter.increment(1);
        });
        pushesAfterSecondOutput = context.pushes.count();
      }),
      then("each output exposes its own committed position", () => {
        assert.equal(firstCount, 1);
        assert.equal(secondCount, 2);
      }),
      then("each separately released position requires a push", () => {
        assert.equal(pushesAfterFirstOutput, 1);
        assert.equal(pushesAfterSecondOutput, 2);
      }),
    ],
  });
});

test("multiple readers of one dirty position share one push", async () => {
  const writerCommitted = Promise.withResolvers<void>();
  const releaseWriter = Promise.withResolvers<void>();
  const firstReaderObserved = Promise.withResolvers<void>();
  const secondReaderObserved = Promise.withResolvers<void>();
  const releaseReaders = Promise.withResolvers<void>();
  let readerStates: GraftCounterState[] = [];
  let pushesBeforeReaderOutputs = -1;
  let pushesAfterReaderOutputs = -1;
  let pushesAfterWriterOutput = -1;

  await runGraftCounterScenario({
    name: "multiple readers observe one dirty position",
    steps: ({ given, when, then }) => [
      given("a durable counter with no pending push", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("two readers observe one unconfirmed writer position", async (context) => {
        const writerOutput = context.output.run(async () => {
          using writer = context.counter.get("one");
          await writer.increment(1);
          writerCommitted.resolve();
          await releaseWriter.promise;
        });
        await writerCommitted.promise;
        const firstReader = context.output.run(async () => {
          using counter = context.counter.get("one");
          const state = await counter.read();
          firstReaderObserved.resolve();
          await releaseReaders.promise;
          return state;
        });
        const secondReader = context.output.run(async () => {
          using counter = context.counter.get("one");
          const state = await counter.read();
          secondReaderObserved.resolve();
          await releaseReaders.promise;
          return state;
        });

        await Promise.all([firstReaderObserved.promise, secondReaderObserved.promise]);
        pushesBeforeReaderOutputs = context.pushes.count();
        releaseReaders.resolve();
        readerStates = await Promise.all([firstReader, secondReader]);
        pushesAfterReaderOutputs = context.pushes.count();
        releaseWriter.resolve();
        await writerOutput;
        pushesAfterWriterOutput = context.pushes.count();
      }),
      then("both readers expose the same dirty position", () => {
        expect(readerStates).toEqual([
          { count: 1, compatibilityValue: null },
          { count: 1, compatibilityValue: null },
        ]);
      }),
      then("the reader outputs share one push", () => {
        assert.equal(pushesBeforeReaderOutputs, 0);
        assert.equal(pushesAfterReaderOutputs, 1);
      }),
      then("the writer output needs no additional push", () => {
        assert.equal(pushesAfterWriterOutput, 1);
      }),
    ],
  });
});

test("concurrent outputs fail closed when their shared push fails", async () => {
  const firstCommitted = Promise.withResolvers<void>();
  const secondCommitted = Promise.withResolvers<void>();
  const releaseOutputs = Promise.withResolvers<void>();
  let outputErrors: string[] = [];
  let controlRemoteLogId = "";

  ({ controlRemoteLogId } = await runGraftCounterScenario({
    name: "concurrent output push failure",
    steps: ({ given, when, then }) => [
      given("two dirty output scopes and a failing next push", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("both outputs are released against the failed push", async (context) => {
        const firstOutput = context.output.run(async () => {
          using counter = context.counter.get("one");
          await counter.increment(1);
          firstCommitted.resolve();
          await releaseOutputs.promise;
        });
        const secondOutput = context.output.run(async () => {
          using counter = context.counter.get("one");
          await counter.increment(1);
          secondCommitted.resolve();
          await releaseOutputs.promise;
        });

        await Promise.all([firstCommitted.promise, secondCommitted.promise]);
        context.pushes.failNextBeforeRemoteCommit();
        releaseOutputs.resolve();
        const results = await Promise.allSettled([firstOutput, secondOutput]);
        outputErrors = results
          .flatMap((result) => (result.status === "rejected" ? [errorMessage(result.reason)] : []))
          .sort();
      }),
      then("neither output reports success", () => {
        expect(outputErrors).toEqual([
          "NODE_RUNTIME_OBJECT_DATABASE_DURABILITY_UNCERTAIN",
          "NODE_RUNTIME_OBJECT_DATABASE_POISONED",
        ]);
      }),
      then("only the failed push was attempted", ({ pushes }) => {
        assert.equal(pushes.count(), 1);
      }),
    ],
  }));

  expect(await readFreshCounterState(controlRemoteLogId, "failed-shared-push")).toEqual({
    count: 0,
    compatibilityValue: null,
  });
});

test("a remotely committed push with a lost response is not replayed", async () => {
  let outputError: string | null = null;
  let poisonedReadError: string | null = null;
  let controlRemoteLogId = "";

  ({ controlRemoteLogId } = await runGraftCounterScenario({
    name: "lost push response after remote commit",
    steps: ({ given, when, then }) => [
      given("a real push whose next response will be lost", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("the request commits and its push response disappears", async (context) => {
        outputError = await captureError(async () => {
          await context.output.run(async () => {
            using counter = context.counter.get("one");
            await counter.increment(1);
            context.pushes.loseNextResponseAfterRemoteCommit();
          });
        });
        poisonedReadError = await captureError(async () => {
          using counter = context.counter.get("one");
          await counter.read();
        });
      }),
      then("the output reports uncertainty and poisons the activation", () => {
        assert.equal(outputError, "NODE_RUNTIME_OBJECT_DATABASE_DURABILITY_UNCERTAIN");
        assert.equal(poisonedReadError, "NODE_RUNTIME_OBJECT_DATABASE_POISONED");
      }),
      then("one real push was attempted", ({ pushes }) => {
        assert.equal(pushes.count(), 1);
      }),
    ],
  }));

  expect(await readFreshCounterState(controlRemoteLogId, "lost-push-response")).toEqual({
    count: 1,
    compatibilityValue: null,
  });
});

test("a reader push can cover a later position than the reader observed", async () => {
  const firstWriterCommit = Promise.withResolvers<void>();
  const readerObserved = Promise.withResolvers<void>();
  const secondWriterCommit = Promise.withResolvers<void>();
  const releaseReader = Promise.withResolvers<void>();
  const releaseWriter = Promise.withResolvers<void>();
  let readerState: GraftCounterState | null = null;
  let writerCount = -1;
  let pushesAfterReader = -1;
  let pushesAfterWriter = -1;

  await runGraftCounterScenario({
    name: "reader push covers a later object head",
    steps: ({ given, when, then }) => [
      given("a writer that pauses after its first commit", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when(
        "the writer commits again after the reader observed its first position",
        async (context) => {
          const writer = context.output.run(async () => {
            using counter = context.counter.get("one");
            await counter.increment(1);
            firstWriterCommit.resolve();
            await readerObserved.promise;
            const count = await counter.increment(1);
            secondWriterCommit.resolve();
            await releaseWriter.promise;
            return count;
          });
          await firstWriterCommit.promise;

          const reader = context.output.run(async () => {
            using counter = context.counter.get("one");
            const state = await counter.read();
            readerObserved.resolve();
            await releaseReader.promise;
            return state;
          });
          await secondWriterCommit.promise;

          releaseReader.resolve();
          readerState = await reader;
          pushesAfterReader = context.pushes.count();
          releaseWriter.resolve();
          writerCount = await writer;
          pushesAfterWriter = context.pushes.count();
        },
      ),
      then("the reader exposes only the first writer position", () => {
        expect(readerState).toEqual({ count: 1, compatibilityValue: null });
      }),
      then("the reader push durably covers the current object head", () => {
        assert.equal(pushesAfterReader, 1);
        assert.equal(writerCount, 2);
      }),
      then("the writer needs no second push", () => {
        assert.equal(pushesAfterWriter, 1);
      }),
    ],
  });
});

test("one external output touching two objects pushes each object log", async () => {
  let counts: number[] = [];
  let pushesBeforeOutput = -1;

  await runGraftCounterScenario({
    name: "one output touches two object logs",
    steps: ({ given, when, then }) => [
      given("two initialized objects with no pending pushes", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("one external request mutates both objects", async (context) => {
        counts = await context.output.run(async () => {
          using first = context.counter.get("one");
          using second = context.counter.get("two");
          const results = await Promise.all([first.increment(1), second.increment(1)]);
          pushesBeforeOutput = context.pushes.count();
          return results;
        });
      }),
      then("both object-local mutations completed", () => {
        expect(counts).toEqual([1, 1]);
      }),
      then("neither object pushes before the external boundary", () => {
        assert.equal(pushesBeforeOutput, 0);
      }),
      then("the external output waits for one push per object log", ({ pushes }) => {
        assert.equal(pushes.count(), 2);
      }),
    ],
  });
});

test("an output gate touching no objects performs no push", async () => {
  let result = "";

  await runGraftCounterScenario({
    name: "output gate without object dependencies",
    steps: ({ given, when, then }) => [
      given("an external output with no object dependency", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("the output is produced without an object RPC", async ({ output }) => {
        result = await output.run(() => "visible result");
      }),
      then("the result is released without a push", ({ pushes }) => {
        assert.equal(result, "visible result");
        assert.equal(pushes.count(), 0);
      }),
    ],
  });
});

test("a nested output gate shares the outer object scope", async () => {
  let count = -1;
  let pushesBeforeOutput = -1;

  await runGraftCounterScenario({
    name: "nested output gate",
    steps: ({ given, when, then }) => [
      given("an outer external output scope", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("a nested gate performs another RPC on the same object", async (context) => {
        count = await context.output.run(async () => {
          using counter = context.counter.get("one");
          await counter.increment(1);
          const nestedCount = await context.output.run(async () => await counter.increment(1));
          pushesBeforeOutput = context.pushes.count();
          return nestedCount;
        });
      }),
      then("both commits remain in the outer scope", () => {
        assert.equal(count, 2);
        assert.equal(pushesBeforeOutput, 0);
      }),
      then("the outer boundary performs one push", ({ pushes }) => {
        assert.equal(pushes.count(), 1);
      }),
    ],
  });
});

test("stubs and capabilities retained after an output scope closes are rejected", async () => {
  let stubError: string | null = null;
  let capabilityError: string | null = null;

  await runGraftCounterScenario({
    name: "closed output scope capabilities",
    steps: ({ given, when, then }) => [
      given("a stub and capability created in external output scopes", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
      when("the scopes close before either retained handle is reused", async (context) => {
        const retainedStub: GraftCounterStub = await context.output.run(() =>
          context.counter.get("one"),
        );
        const retainedCapability: GraftCounterCapability = await context.output.run(async () => {
          using counter = context.counter.get("one");
          return await counter.operationCapability();
        });
        stubError = await captureError(async () => {
          await retainedStub.read();
        });
        capabilityError = await captureError(async () => {
          await retainedCapability.increment(1);
        });
        retainedStub[Symbol.dispose]();
        retainedCapability[Symbol.dispose]();
      }),
      then("both retained handles fail at their closed scope boundary", () => {
        assert.equal(stubError, "NODE_OBJECT_OUTPUT_SCOPE_CLOSED");
        assert.equal(capabilityError, "NODE_OBJECT_OUTPUT_SCOPE_CLOSED");
      }),
      then("closed handles perform no push", ({ pushes }) => {
        assert.equal(pushes.count(), 0);
      }),
    ],
  });
});

async function runGraftCounterScenario(
  definition: GraftCounterScenarioDefinition,
): Promise<{ controlRemoteLogId: string }> {
  const pushCounter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const nextPushBehavior = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const controlRemoteLogId = provisionGraftControlDatabase(scenarioConfigPath);
  const runtime = createGraftCounterRuntime(pushCounter, nextPushBehavior, controlRemoteLogId);
  try {
    using firstCounter = runtime.objects.COUNTER.get("one");
    using secondCounter = runtime.objects.COUNTER.get("two");
    await Promise.all([firstCounter.read(), secondCounter.read()]);
    Atomics.store(pushCounter, 0, 0);
    Atomics.store(nextPushBehavior, 0, 0);

    const context: GraftCounterScenarioContext = {
      counter: runtime.objects.COUNTER,
      output: { run: (operation) => runtime.runWithOutputGate(operation) },
      pushes: {
        count: () => Atomics.load(pushCounter, 0),
        failNextBeforeRemoteCommit: () => {
          Atomics.store(nextPushBehavior, 0, FAIL_NEXT_PUSH_BEFORE_REMOTE_COMMIT);
        },
        loseNextResponseAfterRemoteCommit: () => {
          Atomics.store(nextPushBehavior, 0, LOSE_NEXT_PUSH_RESPONSE_AFTER_REMOTE_COMMIT);
        },
      },
    };
    await runRuntimeScenarioSteps({
      name: definition.name,
      context,
      steps: definition.steps(
        createRuntimeScenarioStepBuilders("GRAFT_RUNTIME_SCENARIO_CONCURRENT_STEP_FAILED"),
      ),
      stepFailurePrefix: "GRAFT_RUNTIME_SCENARIO_STEP_FAILED",
    });
    return { controlRemoteLogId };
  } finally {
    await runtime.cleanup();
  }
}

function createGraftCounterRuntime(
  pushCounter: Int32Array,
  nextPushBehavior: Int32Array,
  controlRemoteLogId: string,
) {
  return createGraftNodeObjectRuntimeWithDatabaseOperations({
    storage: { configPath: scenarioConfigPath, controlRemoteLogId },
    clock: { kind: "system" },
    objects: { COUNTER: counterDefinition },
    databaseOperations: defineGraftDatabaseOperations(
      new URL("../testing/fixtures/graft-database-operations.ts", import.meta.url),
      "createControlledGraftDatabaseOperations",
      { pushCounter: pushCounter.buffer, nextPushBehavior: nextPushBehavior.buffer },
    ),
  });
}

async function readFreshCounterState(
  controlRemoteLogId: string,
  cacheName: string,
): Promise<GraftCounterState> {
  const cacheDirectory = path.join(scenarioDirectory, `${cacheName}-cache`);
  await mkdir(cacheDirectory);
  const configPath = path.join(scenarioDirectory, `${cacheName}.toml`);
  await writeGraftConfig(configPath, cacheDirectory);
  const { stdout } = await executeFile(
    process.execPath,
    [processFixture.pathname, "read", configPath, controlRemoteLogId],
    {
      cwd: path.dirname(processFixture.pathname),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  const resultLine = stdout.split("\n").find((line) => line.startsWith("GRAFT_RUNTIME_RESULT:"));
  if (!resultLine) {
    throw new Error(`GRAFT_RUNTIME_PROCESS_RESULT_MISSING:${stdout}`);
  }
  const result = JSON.parse(resultLine.slice("GRAFT_RUNTIME_RESULT:".length)) as {
    state: GraftCounterState;
  };
  return result.state;
}

async function writeGraftConfig(configPath: string, cacheDirectory: string): Promise<void> {
  await writeFile(
    configPath,
    [
      `data_dir = ${JSON.stringify(cacheDirectory)}`,
      "make_default = false",
      "",
      "[remote]",
      'type = "fs"',
      `root = ${JSON.stringify(scenarioRemoteDirectory)}`,
      "",
    ].join("\n"),
  );
}

async function captureError(operation: () => unknown): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
