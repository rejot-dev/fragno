import { assert, describe, expect, test, vi } from "vitest";

import { automationActorsSchema } from "@fragno-dev/backoffice-api/v0/automation";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import type {
  AutomationsCommands,
  BackofficeObjectHandle,
} from "@/backoffice-runtime/object-registry";
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

import { ApiObject } from "../../../workers/api-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { FormsObject } from "../../../workers/forms-object";
import { UploadObject } from "../../../workers/upload-object";
import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FORMS: (input) => new FormsObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

const workflowParams = (orgId: string, instanceId: string, actors: unknown) => ({
  program: {
    filename: `/workspace/automations/${instanceId}.workflow.js`,
    modules: {
      [`/workspace/automations/${instanceId}.workflow.js`]: `export default defineWorkflow({ name: "ownership-test" }, async () => undefined);`,
    },
    dependencies: {},
    workflowName: "ownership-test",
  },
  trigger: {
    type: "event",
    event: {
      id: `event-${instanceId}`,
      scopeRestriction: null,
      scope: { kind: "org", orgId, jurisdiction: null },
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
    scope: { kind: "org", orgId, jurisdiction: null },
    actors,
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
  object: BackofficeObjectHandle<AutomationsCommands>;
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
            const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
            const ownerExecution = createBackofficeUserExecution({ scope, userId: "owner" });
            const forgedActors = createBackofficeUserExecution({
              scope: { kind: "org", orgId: "org-2", jurisdiction: null },
              userId: "attacker",
            }).actors;
            const object = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });
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
                  };
                };
              };
            };

            expect(instance.meta.params.trigger.event.scope).toEqual(scope);
            expect(instance.meta.params.trigger.event.actors).toEqual(ownerExecution.actors);
            expect(instance.meta.params.execution.scope).toEqual(scope);
            expect(instance.meta.params.execution.actors).toEqual(ownerExecution.actors);
            expect(instance.meta.params.execution).not.toHaveProperty("billingOrganizationId");
          }),
        ],
      }),
    );
  });

  test("ignores forged billing selections in user-scoped single, batch, and restart-or-create requests", async () => {
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
            "ownership and provenance come from execution, not a billing selection",
            async ({ runtime }) => {
              const scope = { kind: "user", userId: "member", jurisdiction: null } as const;
              const execution = createBackofficeUserExecution({ scope, userId: "member" });
              const object = runtime.objects.automations.for(scope);
              const forgedActors = createBackofficeUserExecution({ scope, userId: "owner" }).actors;
              for (const shape of ["single", "batch", "restart-or-create"]) {
                for (const [billingOrganizationId, expectedStatus] of [
                  ["foreign-org", 200],
                  ["", 200],
                  ["org-1", 200],
                ] as const) {
                  const instanceId = `${shape}-${billingOrganizationId || "empty"}`;
                  const params = {
                    ...workflowParams("forged-org", instanceId, forgedActors),
                    trigger: { type: "manual", payload: {} },
                    execution: {
                      scope: { kind: "org", orgId: "forged-org", jurisdiction: null },
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
              scope: { kind: "org", orgId: "org-1", jurisdiction: null },
              userId: "attacker",
            }).actors;
            const response = await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: "org-1", jurisdiction: null })
              .http.fetch(
                workflowRequest({
                  orgId: "org-1",
                  instanceId: "untrusted-workflow",
                  actors: forgedActors,
                }),
              );
            assert(response.status === 403);
          }),
          then.assert("overwrites caller-authored actors for every creation shape", async (ctx) => {
            const scope = { kind: "org" as const, orgId: "org-1", jurisdiction: null };
            const ownerExecution = createBackofficeUserExecution({
              scope,
              userId: "owner",
            });
            const forgedActors = createBackofficeUserExecution({
              scope,
              userId: "attacker",
            }).actors;
            const object = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: "org-1",
              jurisdiction: null,
            });

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
