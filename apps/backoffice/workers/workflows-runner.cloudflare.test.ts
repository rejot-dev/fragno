import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import {
  createWorkflowsTestRuntime,
  runWorkflowsTestTick,
  type WorkflowsTestRunPayload,
} from "@fragno-dev/workflows/test";
import {
  defineWorkflow,
  type WorkflowsFragmentConfig,
  type WorkflowsRegistry,
} from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

type WorkflowsCloudflareTestEnv = typeof env & {
  WORKFLOWS_HARNESS: DurableObjectNamespace;
};

type WorkflowsRuntime = ReturnType<typeof createWorkflowsFragment>;

function wrapDurableObjectSqlErrors(state: DurableObjectState): DurableObjectState {
  const sourceSql = state.storage.sql;
  const sql: SqlStorage = {
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: SqlStorageValue[]
    ): SqlStorageCursor<T> {
      try {
        return sourceSql.exec<T>(query, ...bindings);
      } catch (cause) {
        // Some Durable Object hosts preserve the SQLite error only as the cause of a query error.
        throw new Error(`Durable Object SQLite rejected query: ${query}`, { cause });
      }
    },
    get databaseSize() {
      return sourceSql.databaseSize;
    },
    Cursor: sourceSql.Cursor,
    Statement: sourceSql.Statement,
  };

  return {
    id: state.id,
    storage: {
      transaction: state.storage.transaction.bind(state.storage),
      sql,
    },
  } as DurableObjectState;
}

function createDurableObjectWorkflowsRuntime<TRegistry extends WorkflowsRegistry>(
  state: DurableObjectState,
  config: WorkflowsFragmentConfig<TRegistry>,
) {
  const adapter = new SqlAdapter({
    dialect: new DurableObjectDialect({
      ctx: wrapDurableObjectSqlErrors(state),
      queryInstrumentation: null,
    }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });
  const fragment = createWorkflowsFragment(config, { databaseAdapter: adapter });
  return { fragment };
}

async function runWorkflowService<TResult>(
  fragment: WorkflowsRuntime,
  createServiceCall: () => unknown,
): Promise<TResult> {
  return (await fragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(() => [createServiceCall() as never])
      .transform(({ serviceResult: [result] }) => result as TResult)
      .execute();
  })) as TResult;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function buildWorkflowTickPayload(
  workflowName: string,
  instanceId: string,
  reason: WorkflowsTestRunPayload["reason"],
): WorkflowsTestRunPayload {
  return { workflowName, instanceId, reason };
}

describe("Workflows Runner with Durable Object SQLite", () => {
  test("concurrent create and event ticks retry a Durable Object-wrapped wait-step conflict", async () => {
    const namespace = (env as WorkflowsCloudflareTestEnv).WORKFLOWS_HARNESS;
    const stub = namespace.get(namespace.idFromName("concurrent-create-event-step-insert"));

    await runInDurableObject(stub, async (_instance, state) => {
      const firstPassageStarted = createDeferred();
      const releaseFirstPassage = createDeferred();
      const eventPassageStarted = createDeferred();
      const releaseEventPassage = createDeferred();
      let passageCount = 0;

      const ConcurrentCreateEventWorkflow = defineWorkflow(
        { name: "durable-object-concurrent-create-event-workflow" },
        async (_event, step) => {
          passageCount += 1;
          if (passageCount === 1) {
            firstPassageStarted.resolve();
            await releaseFirstPassage.promise;
          }

          const command = await step.waitForEvent<{ text: string }>("wait-command", {
            type: "command",
            onConsume: async () => {
              eventPassageStarted.resolve();
              await releaseEventPassage.promise;
            },
          });
          return command.payload;
        },
      );
      const workflows = { CONCURRENT_CREATE_EVENT: ConcurrentCreateEventWorkflow };
      const config = {
        workflows,
        runtime: createWorkflowsTestRuntime(),
        autoTickHooks: false,
      } satisfies WorkflowsFragmentConfig<typeof workflows>;
      const mainRuntime = createDurableObjectWorkflowsRuntime(state, config);
      const createRunner = createDurableObjectWorkflowsRuntime(state, config);
      const eventRunner = createDurableObjectWorkflowsRuntime(state, config);
      await migrate(mainRuntime.fragment);

      const { id: instanceId } = await runWorkflowService<{ id: string }>(
        mainRuntime.fragment,
        () =>
          mainRuntime.fragment.services.createInstance(ConcurrentCreateEventWorkflow.name, {
            id: "durable-object-concurrent-create-event-1",
          }),
      );
      const createTick = runWorkflowsTestTick({
        fragment: createRunner.fragment,
        config,
        payload: buildWorkflowTickPayload(ConcurrentCreateEventWorkflow.name, instanceId, "create"),
      });
      await firstPassageStarted.promise;

      await runWorkflowService(mainRuntime.fragment, () =>
        mainRuntime.fragment.services.sendEvent(ConcurrentCreateEventWorkflow.name, instanceId, {
          type: "command",
          payload: { text: "hello" },
        }),
      );
      const eventTick = runWorkflowsTestTick({
        fragment: eventRunner.fragment,
        config,
        payload: buildWorkflowTickPayload(ConcurrentCreateEventWorkflow.name, instanceId, "event"),
      });
      await eventPassageStarted.promise;

      releaseFirstPassage.resolve();
      await createTick;
      releaseEventPassage.resolve();

      await expect(eventTick).resolves.toBeGreaterThanOrEqual(0);
      await expect(
        runWorkflowService(mainRuntime.fragment, () =>
          mainRuntime.fragment.services.getInstanceStatus(
            ConcurrentCreateEventWorkflow.name,
            instanceId,
          ),
        ),
      ).resolves.toMatchObject({ status: "complete", output: { text: "hello" } });
      await expect(
        runWorkflowService(mainRuntime.fragment, () =>
          mainRuntime.fragment.services.listHistory({
            workflowName: ConcurrentCreateEventWorkflow.name,
            instanceId,
          }),
        ),
      ).resolves.toMatchObject({
        steps: [
          expect.objectContaining({
            stepKey: "waitForEvent:wait-command",
            status: "completed",
          }),
        ],
        events: [
          expect.objectContaining({
            type: "command",
            consumedByStepKey: "waitForEvent:wait-command",
          }),
        ],
      });
    });
  });
});
