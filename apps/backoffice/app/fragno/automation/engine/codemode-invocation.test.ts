import { describe, expect, test } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";

import {
  assertCodemodeCapabilityGrantsBelongToExecution,
  CODEMODE_CAPABILITY_ACTOR,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./codemode-invocation";

const FILENAME = "/workspace/automations/canonical-demo.workflow.js";
const PROGRAM = {
  filename: FILENAME,
  modules: {
    [FILENAME]: `export default defineWorkflow({ name: "canonical-demo" }, async (event) => event.payload);`,
  },
  workflowName: "canonical-demo",
};
const execution = createBackofficeUserExecution({
  scope: { kind: "org", orgId: "org-1" },
  userId: "user-1",
});

const event: AutomationEvent = {
  id: "invocation-1",
  scopeRestriction: null,
  scope: execution.scope,
  source: "test",
  eventType: "canonical.requested",
  occurredAt: "2026-08-10T12:00:00.000Z",
  payload: { requestId: "request-1" },
  actors: execution.actors,
  subject: { orgId: "org-1" },
  causation: { kind: "origin" },
};

describe("codemode invocation preparation", () => {
  test("combines a prepared program with trusted invocation context", () => {
    const prepared = prepareCodemodeWorkflowInstance({
      program: PROGRAM,
      instanceId: "instance-1",
    });

    expect(
      createCodemodeWorkflowInstanceInput({
        prepared,
        trigger: { type: "event", event },
        execution,
        replyTo: null,
      }),
    ).toEqual({
      workflowName: "codemode-script",
      remoteWorkflowName: "canonical-demo",
      instanceId: "instance-1",
      params: {
        program: prepared.program,
        trigger: { type: "event", event },
        execution: {
          scopeRestriction: null,
          scope: execution.scope,
          actors: execution.actors,
          capabilityGrants: [],
        },
        replyTo: null,
      },
    });
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
      program: PROGRAM,
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
        replyTo: null,
      }),
    ).toThrow("Codemode event and execution scopes must match.");
  });
});
