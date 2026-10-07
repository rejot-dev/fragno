import { afterAll, beforeAll, assert, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { isWorkflowStepStartedControlPayload } from "@fragno-dev/workflows/step-emission-control";

import { and, eq, queryOnce } from "@tanstack/react-db";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createNodeBackofficeRuntimeConfiguration } from "@/backoffice-runtime/node/node-runtime-env";

import type { AutomationEvent } from "./contracts";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
let runtimeEnv: BackofficeRuntimeEnv;
beforeAll(async () => {
  server = await createCodemodeTestServer();
  runtimeEnv = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  }).runtimeEnv;
});
afterAll(async () => {
  await server?.close();
});

async function waitForValue<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for synchronized workflow state.");
}

async function settleTestCleanupWithin(
  operation: () => Promise<unknown>,
  timeoutMs = 1_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

test("uses codemode setup helpers while keeping setup intent explicit", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "codemode setup helpers arrange state through runtime tools",
      env: runtimeEnv,
      files: backofficeFiles.workspaceStarter(),
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", name: "Ada Labs" }),
        given.codemode.connectionConfigure({
          orgId: "org-1",
          id: "upload",
          payload: { provider: "database" },
        }),
        given.codemode.storeSet({
          orgId: "org-1",
          key: "setup/foo",
          value: "from-codemode",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/setup.txt",
          content: "setup helper wrote this",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/setup.bin",
          content: new Uint8Array([0x62, 0x69, 0x6e, 0x61, 0x72, 0x79]),
        }),
      ],
      steps: ({ then }) => [
        then.connection.configured({ orgId: "org-1", id: "upload" }),
        then.store.entry({
          orgId: "org-1",
          key: "setup/foo",
          value: "from-codemode",
        }),
        then.files.contains({
          orgId: "org-1",
          path: "/workspace/setup.txt",
          text: "setup helper wrote this",
        }),
        then.files.contains({
          orgId: "org-1",
          path: "/workspace/setup.bin",
          text: "binary",
        }),
        then.codemode.toolCalls({
          include: ["connections.configure", "store.set"],
        }),
      ],
    }),
  );
});

test("scenario TanStack DB exposes an in-flight step.do lifecycle", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "scenario TanStack DB exposes an in-flight step.do lifecycle",
      env: runtimeEnv,
      files: backofficeFiles.custom({
        workspace: {
          "automations/tanstack-live-step.workflow.js": `defineWorkflow(
  { name: "tanstack-live-step" },
  async (_event, step) => {
    await step.do("blocked operation", async (tx) => {
      await new Promise((resolve) => {
        tx.onEvent("release", (event) => {
          event.consume();
          resolve();
        });
      });
    });
  },
);`,
        },
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("assert live step controls synchronize", async (ctx) => {
          const scope = { kind: "org" as const, orgId: "org-1" };
          const execution = createBackofficeSystemExecution(scope);
          const workflow = createRouteBackedAutomationWorkflowRuntime({
            object: ctx.runtime.objects.automations.forOrg(scope.orgId),
            execution,
          });
          const workflowPath = "/workspace/automations/tanstack-live-step.workflow.js";
          const event: AutomationEvent = {
            id: "tanstack-live-step-event",
            scopeRestriction: null,
            scope,
            source: "custom",
            eventType: "thing.happened",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {},
            actors: execution.actors,
            subject: { orgId: "org-1" },
          };
          const prepared = prepareCodemodeWorkflowInstance({
            code: await ctx.files.forOrg("org-1").readFile(workflowPath, "utf-8"),
            filename: workflowPath,
            instanceId: "tanstack-live-step-run",
          });
          assert(prepared.remoteWorkflowName === "tanstack-live-step");
          const workflowInput = createCodemodeWorkflowInstanceInput({
            prepared,
            trigger: { type: "event", event },
            execution,
            billingOrganizationId: null,
          });
          await workflow.createInternalInstance(workflowInput);

          const database = ctx.tanstack.automations.forOrg("org-1");
          const drainPromise = ctx.runtime.drain();
          let released = false;
          let drainCompleted = false;
          try {
            const activeEmission = await waitForValue(async () => {
              await database.sync();
              const instance = await queryOnce((query) =>
                query
                  .from({ instance: database.collections.workflowInstances })
                  .where(({ instance }) =>
                    and(
                      eq(instance.workflowName, "codemode-script"),
                      eq(instance.instanceId, "tanstack-live-step-run"),
                    ),
                  )
                  .findOne(),
              );
              if (!instance) {
                return null;
              }
              const emissions = await queryOnce((query) =>
                query
                  .from({ emission: database.collections.workflowStepEmissions })
                  .where(({ emission }) => eq(emission.instanceRef, instance.id)),
              );
              return (
                emissions.find(
                  (emission) =>
                    emission.actor === "system" &&
                    emission.stepKey === "do:blocked operation" &&
                    isWorkflowStepStartedControlPayload(emission.payload),
                ) ?? null
              );
            });
            assert.equal(activeEmission.stepKey, "do:blocked operation");
            await workflow.sendInternalEvent({
              workflowName: "codemode-script",
              instanceId: "tanstack-live-step-run",
              type: "release",
              payload: null,
            });
            released = true;
            await drainPromise;
            drainCompleted = true;

            await database.sync();
            const completedStep = await queryOnce((query) =>
              query
                .from({ step: database.collections.workflowSteps })
                .where(({ step }) => eq(step.stepKey, "do:blocked operation"))
                .findOne(),
            );
            assert.equal(completedStep?.status, "completed");
            const remainingEmissions = await queryOnce((query) =>
              query.from({ emission: database.collections.workflowStepEmissions }),
            );
            assert.equal(remainingEmissions.length, 0);
          } finally {
            if (!released) {
              await settleTestCleanupWithin(() =>
                workflow.sendInternalEvent({
                  workflowName: "codemode-script",
                  instanceId: "tanstack-live-step-run",
                  type: "release",
                  payload: null,
                }),
              );
            }
            if (!drainCompleted) {
              await settleTestCleanupWithin(() => drainPromise);
            }
          }
        }),
      ],
    }),
  );
});
