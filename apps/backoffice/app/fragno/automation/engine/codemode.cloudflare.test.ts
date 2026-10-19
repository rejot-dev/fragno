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
  test("exposes Backoffice capability tools to workflow codemode automations", async () => {
    const calls: unknown[] = [];
    const event: AutomationEvent = {
      id: "event-workflow-list-capabilities",
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
      causation: { kind: "origin" },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-capabilities-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          modules: {},
          env,
          workflowEvent,
          remote,
          context: createAutomationContext(event, {
            backofficeRuntime: createRecordingBackofficeRuntime(calls),
          }),
          script: `defineWorkflow(
            { name: "list-capabilities" },
            async (event, step) => {
              return await step.do("list capabilities", async () => ({
                capabilities: await capabilities.list(),
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
      id: "codemode-workflow-capabilities-test-1",
      remoteWorkflowName: "list-capabilities",
      params: { automationEvent: event },
    });
    await harness.runUntilIdle({
      workflowName: "codemode-workflow-capabilities-test",
      instanceId,
      reason: "create",
    });

    await expect(harness.getStatus("WORKFLOW", instanceId)).resolves.toMatchObject({
      status: "complete",
      output: expect.objectContaining({
        exitCode: 0,
        result: {
          capabilities: [uploadCapabilitySummary],
          eventId: "event-workflow-list-capabilities",
        },
      }),
    });
    expect(calls).toEqual(["listCapabilities"]);
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
      causation: { kind: "origin" },
    };
    const Workflow = defineRemoteWorkflow(
      { name: "codemode-workflow-egress-test" },
      async (workflowEvent, remote) =>
        await executeWorkflowCodemodeAutomation({
          modules: {},
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

const uploadCapabilitySummary = {
  id: "upload",
  label: "Upload",
  kind: "connection" as const,
  available: true,
  configured: true,
};

const createRecordingBackofficeRuntime = (calls: unknown[]): BackofficeCapabilitiesRuntime =>
  new Proxy(
    {
      listCapabilities: async () => {
        calls.push("listCapabilities");
        return [uploadCapabilitySummary];
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
