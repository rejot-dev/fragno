import { describe, expect, test } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createWorkflowsTestHarness } from "@fragno-dev/workflows/test";
import { defineRemoteWorkflow } from "@fragno-dev/workflows/workflow";
import { env } from "cloudflare:workers";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { AutomationRuntimeHostContext, AutomationRuntime } from "@/fragno/automation";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import { CODEMODE_CAPABILITY_ACTOR } from "@/fragno/automation/engine/codemode-invocation";
import { createTestStateBackend } from "@/fragno/codemode/state-backend.test-utils";
import { EMPTY_BASH_HOST_CONTEXT } from "@/fragno/runtime-tools/bash-host.test-utils";
import { createUnavailableAutomationRouterRuntime } from "@/fragno/runtime-tools/families/automations-routing";
import type { BackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createUnavailableEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";

import { executeWorkflowCodemodeAutomation } from "./codemode";
import { defineCodemodeWorkflow } from "./codemode-workflow";

describe("executeWorkflowCodemodeAutomation", () => {
  test("exposes connection configuration tools to workflow codemode automations", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-workflow-configure-upload",
      scopeRestriction: null,
      scope: { kind: "org", orgId: "org-1" },
      source: "auth",
      eventType: "organization.created",
      occurredAt: "2026-06-12T00:00:00.000Z",
      payload: { id: "org-1", name: "Org 1", slug: "org-1" },
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-connections-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          env,
          workflowEvent,
          remote,
          context: createAutomationContext(event, {
            backofficeRuntime: createRecordingBackofficeRuntime(calls),
          }),
          script: `defineWorkflow(
            { name: "configure-upload-connection" },
            async (event, step) => {
              return await step.do("configure upload database connection", async () => ({
                ...(await connections.configure({
                  id: "upload",
                  payload: { provider: "database" },
                })),
                eventId: event.id,
              }));
            },
          );`,
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });

    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-workflow-connections-test-1",
      remoteWorkflowName: "configure-upload-connection",
      params: { automationEvent: event },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-workflow-connections-test",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        exitCode: 0,
        result: expect.objectContaining({
          id: "upload",
          configured: true,
          config: { provider: "database" },
          eventId: "event-workflow-configure-upload",
        }),
      }),
    });
    expect(calls).toEqual([
      ["configureConnection", { id: "upload", payload: { provider: "database" } }],
    ]);
  });

  test("rejects persisted capability grants outside the execution actor chain", async () => {
    const execution = createBackofficeSystemExecution({ kind: "org", orgId: "org-1" });
    const Workflow = defineCodemodeWorkflow({
      env: env as Parameters<typeof defineCodemodeWorkflow>[0]["env"],
      runtime: {} as BackofficeRuntimeServices,
    });
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "invalid-capability-grant-1",
      remoteWorkflowName: "invalid-capability-grant",
      params: {
        program: {
          code: `defineWorkflow({ name: "invalid-capability-grant" }, async () => undefined);`,
          dependencies: {},
          workflowName: "invalid-capability-grant",
          filename: "/workspace/automations/invalid-capability-grant.workflow.js",
        },
        trigger: { type: "manual", payload: {} },
        execution: {
          scopeRestriction: null,
          scope: execution.scope,
          actors: execution.actors,
          capabilityGrants: [
            {
              actor: CODEMODE_CAPABILITY_ACTOR,
              permissions: [BACKOFFICE_PERMISSION.router.modify],
            },
          ],
        },
      },
    });

    await harness.runUntilIdle({
      workflowName: "codemode-script",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "errored",
      error: {
        message: expect.stringContaining("is not part of the execution delegation chain"),
      },
    });
  });

  test("seals workflow codemode egress", async () => {
    const event: AutomationEvent = {
      id: "event-workflow-egress",
      scopeRestriction: null,
      scope: { kind: "org", orgId: "org-1" },
      source: "test",
      eventType: "workflow.egress",
      occurredAt: "2026-08-11T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-egress-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          env,
          workflowEvent,
          remote,
          context: createAutomationContext(event),
          script: `defineWorkflow(
            { name: "blocked-workflow-egress" },
            async (_event, step) => {
              return await step.do("blocked fetch", async () => {
                const response = await fetch("https://example.com/private");
                return await response.text();
              });
            },
          );`,
        }),
    );
    const harness = await createWorkflowsTestHarness({
      workflows: { WORKFLOW: Workflow },
      adapter: { type: "in-memory" },
      testBuilder: buildDatabaseFragmentsTest(),
      autoTickHooks: false,
    });
    const instanceId = await harness.createInstance("WORKFLOW", {
      id: "codemode-workflow-egress-test-1",
      remoteWorkflowName: "blocked-workflow-egress",
    });

    await harness.runUntilIdle({
      workflowName: "codemode-workflow-egress-test",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        exitCode: 1,
        stderr: expect.stringContaining("not permitted to access the internet"),
      }),
    });
  });
});

type AutomationContextOptions = {
  runtime?: AutomationRuntime;
  backofficeRuntime?: BackofficeCapabilitiesRuntime;
  otpRuntime?: AutomationRuntimeHostContext["otp"]["runtime"];
  piRuntime?: NonNullable<AutomationRuntimeHostContext["pi"]>["runtime"] | null;
  telegramRuntime?: NonNullable<AutomationRuntimeHostContext["telegram"]>["runtime"];
  binding?: Partial<AutomationRuntimeHostContext["automation"]["binding"]>;
};

const createAutomationContext = (
  event: AutomationEvent,
  runtimeOrOptions: AutomationRuntime | AutomationContextOptions = createUnusedAutomationRuntime(),
): AutomationRuntimeHostContext => {
  const options = "get" in runtimeOrOptions ? { runtime: runtimeOrOptions } : runtimeOrOptions;
  const runtime = options.runtime ?? createUnusedAutomationRuntime();

  return {
    ...EMPTY_BASH_HOST_CONTEXT,
    stateBackend: createTestStateBackend(),
    backoffice: options.backofficeRuntime ? { runtime: options.backofficeRuntime } : null,
    automation: {
      event,
      orgId: event.scope.kind === "org" ? event.scope.orgId : undefined,
      binding: {
        id: "codemode-binding",
        source: event.source,
        eventType: event.eventType,
        scriptId: "script:codemode@1:scripts/context-writer.cm.js",
        scriptKey: "codemode",
        scriptName: "Codemode",
        scriptPath: "scripts/context-writer.cm.js",
        scriptVersion: 1,
        ...options.binding,
      },
      idempotencyKey: "idem-codemode",
      runtime,
    },
    automations: { runtime },
    otp: { runtime: options.otpRuntime ?? runtime },
    pi: options.piRuntime ? { runtime: options.piRuntime } : null,
    resend: { runtime: createUnavailableRuntime("resend") },
    telegram: { runtime: options.telegramRuntime ?? createUnavailableRuntime("telegram") },
  };
};

const createUnusedAutomationRuntime = (): AutomationRuntime => ({
  ...createUnavailableAutomationRouterRuntime(),
  ...createUnavailableEventRuntime(),
  get: async () => {
    throw new Error("get should not be called in this test.");
  },
  set: async () => {
    throw new Error("set should not be called in this test.");
  },
  delete: async () => {
    throw new Error("delete should not be called in this test.");
  },
  list: async () => {
    throw new Error("list should not be called in this test.");
  },
  createClaim: async () => {
    throw new Error("createClaim should not be called in this test.");
  },
  emitEvent: async () => {
    throw new Error("emitEvent should not be called in this test.");
  },
});

const createRecordingBackofficeRuntime = (calls: unknown[]): BackofficeCapabilitiesRuntime =>
  new Proxy(
    {
      configureConnection: async (input: { id: string; payload: unknown; origin?: string }) => {
        calls.push(["configureConnection", input]);
        return {
          id: input.id,
          label: input.id,
          kind: "connection" as const,
          configured: true,
          config: input.payload as Record<string, unknown>,
        };
      },
    },
    {
      get(target, property: string) {
        if (property in target) {
          return target[property as keyof typeof target];
        }
        return async () => {
          throw new Error(property + " should not be called in this test.");
        };
      },
    },
  ) as BackofficeCapabilitiesRuntime;

const createUnavailableRuntime = (name: string) =>
  new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(`${name} runtime should not be called in this test.`);
        };
      },
    },
  ) as never;
