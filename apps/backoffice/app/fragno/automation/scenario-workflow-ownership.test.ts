import { assert, describe, expect, test, vi } from "vitest";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type {
  AutomationsObject,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
import { automationActorsSchema } from "@/fragno/automation/actors";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

import { InMemoryApiObject } from "../../../workers/api.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const workflowParams = (orgId: string, instanceId: string, actors: unknown) => ({
  program: {
    code: `defineWorkflow({ name: "ownership-test" }, async () => undefined);`,
    dependencies: {},
    workflowName: "ownership-test",
    filename: `/workspace/automations/${instanceId}.workflow.js`,
  },
  trigger: {
    type: "event",
    event: {
      id: `event-${instanceId}`,
      scopeRestriction: null,
      scope: { kind: "org", orgId },
      source: "test",
      eventType: "workflow.ownership",
      occurredAt: "2026-08-05T00:00:00.000Z",
      payload: {},
      actors,
      subject: { orgId },
    },
  },
  execution: {
    scopeRestriction: null,
    scope: { kind: "org", orgId },
    actors,
    billingOrganizationId: "caller-billing-org",
    capabilityGrants: [],
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
    `https://workflows.test/api/workflows/${CODEMODE_WORKFLOW}/instances${batch ? "/batch" : ""}`,
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
  object: BackofficeObjectHandle<AutomationsObject>;
  execution: ReturnType<typeof createBackofficeUserExecution>;
  instanceId: string;
}) => {
  const response = await object.http.fetchAuthorized(
    new Request(
      `https://workflows.test/api/workflows/${CODEMODE_WORKFLOW}/instances/${instanceId}`,
    ),
    { execution, propagationContext: null },
  );
  assert(response.status === 200);
  const instance = (await response.json()) as {
    meta: { params: { execution?: { actors?: unknown } } };
  };
  return automationActorsSchema.parse(instance.meta.params.execution?.actors);
};

describe("scenario workflow ownership", () => {
  test("derives caller-created automation event scope and actors from trusted execution", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
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
            const created = await object.http.fetchAuthorized(
              workflowRequest({
                orgId: "org-2",
                instanceId: "forged-event-context",
                actors: forgedActors,
              }),
              { execution: ownerExecution, propagationContext: null },
            );
            assert(created.status === 200);

            const response = await object.http.fetchAuthorized(
              new Request(
                `https://workflows.test/api/workflows/${CODEMODE_WORKFLOW}/instances/forged-event-context`,
              ),
              { execution: ownerExecution, propagationContext: null },
            );
            assert(response.status === 200);
            const instance = (await response.json()) as {
              meta: {
                params: {
                  trigger: { event: { scope: unknown; actors: unknown } };
                  execution: {
                    scope: unknown;
                    actors: unknown;
                    billingOrganizationId: string | null;
                  };
                };
              };
            };

            expect(instance.meta.params.trigger.event.scope).toEqual(scope);
            expect(instance.meta.params.trigger.event.actors).toEqual(ownerExecution.actors);
            expect(instance.meta.params.execution.scope).toEqual(scope);
            expect(instance.meta.params.execution.actors).toEqual(ownerExecution.actors);
            assert.equal(instance.meta.params.execution.billingOrganizationId, "org-1");
          }),
        ],
      }),
    );
  });

  test("authorizes user-scoped billing selections before single, batch, and restart-or-create persistence", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "workflow billing selection authorization",
        options: { drain: false },
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
        ],
        steps: ({ then }) => [
          then.assert(
            "only an authorized billing selection is persisted with trusted provenance",
            async ({ runtime }) => {
              const scope = { kind: "user", userId: "member" } as const;
              const execution = createBackofficeUserExecution({ scope, userId: "member" });
              const object = runtime.objects.automations.for(scope);
              const forgedActors = createBackofficeUserExecution({ scope, userId: "owner" }).actors;
              for (const shape of ["single", "batch", "restart-or-create"]) {
                for (const [billingOrganizationId, expectedStatus] of [
                  ["foreign-org", 403],
                  ["", 400],
                  ["org-1", 200],
                ] as const) {
                  const instanceId = `${shape}-${expectedStatus}`;
                  const params = {
                    ...workflowParams("forged-org", instanceId, forgedActors),
                    trigger: { type: "manual", payload: {} },
                    execution: {
                      scope: { kind: "org", orgId: "forged-org" },
                      actors: forgedActors,
                      capabilityGrants: [],
                      billingOrganizationId,
                      userAuthority: { role: "admin" },
                    },
                  };
                  const body =
                    shape === "batch"
                      ? {
                          instances: [{ id: instanceId, params }],
                          remoteWorkflowName: "ownership-test",
                        }
                      : shape === "restart-or-create"
                        ? {
                            create: { params, remoteWorkflowName: "ownership-test" },
                            restart: { precondition: { status: { in: ["complete"] } } },
                          }
                        : { id: instanceId, params, remoteWorkflowName: "ownership-test" };
                  const suffix =
                    shape === "batch"
                      ? "/batch"
                      : shape === "restart-or-create"
                        ? `/${instanceId}/restart-or-create`
                        : "";
                  const created = await object.http.fetchAuthorized(
                    new Request(
                      `https://workflows.test/api/workflows/${CODEMODE_WORKFLOW}/instances${suffix}`,
                      {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(body),
                      },
                    ),
                    { execution, propagationContext: null },
                  );
                  assert.equal(created.status, expectedStatus, await created.clone().text());
                  const response = await object.http.fetchAuthorized(
                    new Request(
                      `https://workflows.test/api/workflows/${CODEMODE_WORKFLOW}/instances/${instanceId}`,
                    ),
                    { execution, propagationContext: null },
                  );
                  if (expectedStatus !== 200) {
                    assert.equal(response.status, 404, await response.clone().text());
                    continue;
                  }
                  assert.equal(response.status, 200, await response.clone().text());
                  const stored = await response.json<{
                    meta: { params: { execution: unknown } };
                  }>();
                  expect(stored.meta.params.execution).toEqual({
                    scopeRestriction: null,
                    scope,
                    actors: execution.actors,
                    capabilityGrants: [],
                    billingOrganizationId: "org-1",
                  });
                }
              }
            },
          ),
        ],
      }),
    );
  });

  test("persists trusted workflow actors for single and batch creation", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
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
            const response = await ctx.runtime.objects.automations.forOrg("org-1").http.fetch(
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
              const response = await object.http.fetchAuthorized(
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
