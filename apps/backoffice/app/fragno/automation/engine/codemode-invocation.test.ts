import { describe, expect, test } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

import type { AutomationEvent } from "../contracts";
import {
  assertCodemodeCapabilityGrantsBelongToExecution,
  CODEMODE_CAPABILITY_ACTOR,
  codemodeWorkflowParamsSchema,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./codemode-invocation";

const SOURCE = `defineWorkflow({ name: "canonical-demo" }, async (event) => event.payload);`;
const execution = createBackofficeUserExecution({
  scope: { kind: "org", orgId: "org-1" },
  userId: "user-1",
});

const event: AutomationEvent = {
  id: "invocation-1",
  scope: execution.scope,
  source: "test",
  eventType: "canonical.requested",
  occurredAt: "2026-08-10T12:00:00.000Z",
  payload: { requestId: "request-1" },
  actors: execution.actors,
  subject: { orgId: "org-1" },
};

describe("codemode invocation preparation", () => {
  test("prepares the same program snapshot for every source origin", () => {
    const filenames = [
      "/workspace/automations/canonical-demo.workflow.js",
      "/pi/session-1/tool-1.workflow.js",
      ".marketplace/install.workflow.js",
    ];

    const preparedInstances = filenames.map((filename, index) =>
      prepareCodemodeWorkflowInstance({
        code: SOURCE,
        dependencies: { zod: "4.3.5" },
        filename,
        instanceId: `instance-${index + 1}`,
      }),
    );

    for (const [index, prepared] of preparedInstances.entries()) {
      expect(prepared).toEqual({
        workflowName: "codemode-script",
        remoteWorkflowName: "canonical-demo",
        instanceId: `instance-${index + 1}`,
        program: {
          code: SOURCE,
          dependencies: { zod: "4.3.5" },
          workflowName: "canonical-demo",
          filename: filenames[index],
        },
      });
    }
  });

  test("combines a prepared program with trusted invocation context", () => {
    const prepared = prepareCodemodeWorkflowInstance({
      code: SOURCE,
      filename: "/workspace/automations/canonical-demo.workflow.js",
      instanceId: "instance-1",
    });

    expect(
      createCodemodeWorkflowInstanceInput({
        prepared,
        trigger: { type: "event", event },
        execution,
      }),
    ).toEqual({
      workflowName: "codemode-script",
      remoteWorkflowName: "canonical-demo",
      instanceId: "instance-1",
      params: {
        program: prepared.program,
        trigger: { type: "event", event },
        execution: { scope: execution.scope, actors: execution.actors, capabilityGrants: [] },
      },
    });
  });

  test("preserves internal workflow completion metadata while validating canonical fields", () => {
    const prepared = prepareCodemodeWorkflowInstance({
      code: SOURCE,
      filename: "/workspace/automations/canonical-demo.workflow.js",
      instanceId: "instance-1",
    });
    const input = createCodemodeWorkflowInstanceInput({
      prepared,
      trigger: { type: "manual", payload: { requestId: "request-1" } },
      execution,
    });
    const completion = { workflowName: "parent-workflow", instanceId: "parent-instance" };

    expect(
      codemodeWorkflowParamsSchema.parse({
        ...input.params,
        __workflowCompletion: completion,
      }),
    ).toMatchObject({ __workflowCompletion: completion });
  });

  test("rejects persisted capability grants outside the execution delegation chain", () => {
    expect(() =>
      assertCodemodeCapabilityGrantsBelongToExecution({
        execution,
        capabilityGrants: [
          {
            actor: CODEMODE_CAPABILITY_ACTOR,
            permissions: [BACKOFFICE_PERMISSION.router.modify],
          },
        ],
      }),
    ).toThrow("is not part of the execution delegation chain");
  });

  test("rejects trusted invocation context from a different scope", () => {
    const prepared = prepareCodemodeWorkflowInstance({
      code: SOURCE,
      filename: "/workspace/automations/canonical-demo.workflow.js",
      instanceId: "instance-1",
    });

    expect(() =>
      createCodemodeWorkflowInstanceInput({
        prepared,
        trigger: {
          type: "event",
          event: { ...event, scope: { kind: "org", orgId: "org-2" } },
        },
        execution,
      }),
    ).toThrow("Codemode event and execution scopes must match.");
  });
});
