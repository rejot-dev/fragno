import { assert, describe, expect, test, vi } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type { AutomationsObject, BackofficeRpcObject } from "@/backoffice-runtime/object-registry";
import {
  automationActorsSchema,
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
} from "@/fragno/automation/actors";
import { AUTOMATION_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/workflow-start";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const workflowParams = (orgId: string, instanceId: string, actors: unknown) => ({
  automationEvent: {
    id: `event-${instanceId}`,
    scope: { kind: "org", orgId },
    source: "test",
    eventType: "workflow.ownership",
    occurredAt: "2026-08-05T00:00:00.000Z",
    payload: {},
    actors,
    subject: { orgId },
  },
  workflowScriptPath: `/workspace/automations/${instanceId}.workflow.js`,
  workflowInstanceId: instanceId,
  metadata: {
    [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: actors,
  },
});

const workflowRequest = ({
  orgId,
  instanceId,
  actors,
  batch = false,
}: {
  orgId: string;
  instanceId: string;
  actors: unknown;
  batch?: boolean;
}) =>
  new Request(
    `https://workflows.test/api/workflows/${AUTOMATION_CODEMODE_WORKFLOW}/instances${batch ? "/batch" : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        batch
          ? {
              instances: [
                {
                  id: instanceId,
                  params: workflowParams(orgId, instanceId, actors),
                },
              ],
              remoteWorkflowName: "ownership-test",
            }
          : {
              id: instanceId,
              params: workflowParams(orgId, instanceId, actors),
              remoteWorkflowName: "ownership-test",
            },
      ),
    },
  );

const loadWorkflowActors = async ({
  object,
  execution,
  instanceId,
}: {
  object: BackofficeRpcObject<AutomationsObject>;
  execution: ReturnType<typeof createBackofficeUserExecution>;
  instanceId: string;
}) => {
  const response = await object.fetchWithContext(
    new Request(
      `https://workflows.test/api/workflows/${AUTOMATION_CODEMODE_WORKFLOW}/instances/${instanceId}`,
    ),
    { execution, propagationContext: null },
  );
  assert(response.status === 200);
  const instance = (await response.json()) as {
    meta: { params: { metadata?: Record<string, unknown> } };
  };
  return automationActorsSchema.parse(
    instance.meta.params.metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
  );
};

describe("scenario workflow ownership", () => {
  test("derives caller-created automation event scope and actors from trusted execution", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "trusted automation workflow event context",
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "attacker", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            ownerUserId: "owner",
            ownerRoles: ["owner"],
          }),
        ],
        steps: ({ then }) => [
          then.assert("caller-authored event context is replaced", async (ctx) => {
            const scope = { kind: "org" as const, orgId: "org-1" };
            const ownerExecution = createBackofficeUserExecution({ scope, userId: "owner" });
            const forgedActors = createBackofficeUserExecution({
              scope: { kind: "org", orgId: "org-2" },
              userId: "attacker",
            }).actors;
            const object = ctx.runtime.objects.automations.forOrg("org-1");
            const created = await object.fetchWithContext(
              workflowRequest({
                orgId: "org-2",
                instanceId: "forged-event-context",
                actors: forgedActors,
              }),
              { execution: ownerExecution, propagationContext: null },
            );
            assert(created.status === 200);

            const response = await object.fetchWithContext(
              new Request(
                `https://workflows.test/api/workflows/${AUTOMATION_CODEMODE_WORKFLOW}/instances/forged-event-context`,
              ),
              { execution: ownerExecution, propagationContext: null },
            );
            assert(response.status === 200);
            const instance = (await response.json()) as {
              meta: {
                params: {
                  automationEvent: { scope: unknown; actors: unknown };
                };
              };
            };

            expect(instance.meta.params.automationEvent.scope).toEqual(scope);
            expect(instance.meta.params.automationEvent.actors).toEqual(ownerExecution.actors);
          }),
        ],
      }),
    );
  });

  test("persists trusted workflow actors for single and batch creation", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "trusted automation workflow ownership",
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "attacker", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            ownerUserId: "owner",
            ownerRoles: ["owner"],
          }),
        ],
        steps: ({ then }) => [
          then.assert("rejects creation without trusted execution", async (ctx) => {
            const forgedActors = createBackofficeUserExecution({
              scope: { kind: "org", orgId: "org-1" },
              userId: "attacker",
            }).actors;
            const response = await ctx.runtime.objects.automations.forOrg("org-1").fetch(
              workflowRequest({
                orgId: "org-1",
                instanceId: "untrusted-workflow",
                actors: forgedActors,
              }),
            );
            assert(response.status === 403);
          }),
          then.assert("overwrites caller-authored actors for every creation shape", async (ctx) => {
            const scope = { kind: "org" as const, orgId: "org-1" };
            const ownerExecution = createBackofficeUserExecution({
              scope,
              userId: "owner",
            });
            const forgedActors = createBackofficeUserExecution({
              scope,
              userId: "attacker",
            }).actors;
            const object = ctx.runtime.objects.automations.forOrg("org-1");

            for (const [instanceId, batch] of [
              ["owned-single", false],
              ["owned-batch", true],
            ] as const) {
              const response = await object.fetchWithContext(
                workflowRequest({ orgId: "org-1", instanceId, actors: forgedActors, batch }),
                { execution: ownerExecution, propagationContext: null },
              );
              assert(response.status === 200);

              const persistedActors = await loadWorkflowActors({
                object,
                execution: ownerExecution,
                instanceId,
              });
              expect(persistedActors.principal).toMatchObject({
                type: "user",
                id: "owner",
                role: "principal",
              });
            }
          }),
        ],
      }),
    );
  });
});
