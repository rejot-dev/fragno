import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }
  class MockRpcTarget {}
  class MockWorkerEntrypoint {}
  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { MARKETPLACE_PUBLISH_WORKFLOW_NAME } from "@/fragno/automation/marketplace-publish-workflow";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { marketplaceStaticPublicationResultSchema } from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { listStaticMarketplaceEntries } from "@/fragno/marketplace/static-entries";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { internalMarketplaceToolFamily } from "./internal";

describe("internal maintenance scope scenarios", () => {
  test("publishes bundled marketplace entries in System without an organization", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "System owns bundled marketplace publication",
        files: backofficeFiles.systemOnly(),
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", email: "admin@example.com", role: "admin" }),
        ],
        steps: ({ when, then }) => [
          when.codemode.run({
            scope: { kind: "system" },
            code: "async () => await internal.marketplacePush({})",
            assertToolCalls: ["internal.marketplace.push"],
          }),
          then.assert("publication completes in singleton Automations storage", async (ctx) => {
            const entries = listStaticMarketplaceEntries();
            assert(entries.length > 0);
            for (const entry of entries) {
              const listingId = marketplaceListingId({
                ownerScope: entry.owner.scope,
                slug: entry.slug,
              });
              await expect(
                ctx.runtime.objects.marketplace
                  .singleton()
                  .commands.getArtifactManifest({ listingId }),
              ).resolves.toMatchObject({
                listingStatus: "published",
                versions: expect.arrayContaining([entry.version]),
              });
            }
            const context = createRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeUserExecution({
                scope: { kind: "system" },
                userId: "admin-1",
              }),
              billingOrganizationId: null,
            });
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const result = await bash.exec("internal.marketplace.push --format json");
            assert(result.exitCode === 0, result.stderr);
            const repeated = marketplaceStaticPublicationResultSchema.parse(
              JSON.parse(result.stdout),
            );
            expect(repeated.publications).toHaveLength(entries.length);
            assert(repeated.publications.every((publication) => publication.state === "published"));

            const workflow = createRouteBackedAutomationWorkflowRuntime({
              object: ctx.runtime.objects.automations.singleton(),
              execution: createBackofficeSystemExecution({ kind: "system" }),
            });
            const instances = await workflow.listInternalInstances({
              workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
              pageSize: 100,
            });
            expect(instances.instances).toHaveLength(entries.length);
            assert(instances.instances.every((instance) => instance.details.status === "complete"));
            await expect(
              ctx.runtime.objects.auth.singleton().commands.getAllOrganizations(),
            ).resolves.toEqual([]);
          }),
        ],
      }),
    );
  });

  test("rejects publication in organization, project, and user contexts at every entry point", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        name: "non-System contexts cannot publish bundled marketplace entries",
        vars: () => ({ projectId: "" }),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "owner-1" }),
        ],
        steps: ({ when, then, runner }) => [
          when.project.create({
            orgId: "org-1",
            name: "Delivery",
            slug: "delivery",
            createdByUserId: "owner-1",
            captureIdAs: "projectId",
          }),
          then.assert("tools and object commands reject non-System publication", async (ctx) => {
            const scopes: BackofficeContextScope[] = [
              { kind: "org", orgId: "org-1" },
              { kind: "project", orgId: "org-1", projectId: ctx.vars.projectId },
              { kind: "user", userId: "owner-1" },
            ];
            for (const scope of scopes) {
              await expect(
                ctx.runCodemode({
                  scope,
                  code: "async () => await context.current.internal.marketplacePush({})",
                }),
              ).rejects.toThrow("Unknown scoped tool: internal.marketplacePush");
              const execution = createBackofficeSystemExecution(scope);
              const context = createRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution,
                billingOrganizationId: null,
              });
              assert(context.stateBackend);
              const { bash } = createInteractiveBashHost({
                context: { ...context, stateBackend: context.stateBackend },
              });
              const result = await bash.exec("internal.marketplace.push --format json");
              expect(result.exitCode).not.toBe(0);
              expect(result.stderr).toContain("Backoffice command unavailable");
              await expect(
                executeBackofficeRuntimeTool(
                  internalMarketplaceToolFamily.tools[0],
                  {},
                  createBackofficeToolContext(context),
                ),
              ).rejects.toThrow("Static marketplace publication requires System context.");
              const object = ctx.runtime.objects.automations.for(scope);
              await expect(object.commands.requestStaticMarketplacePublications()).rejects.toThrow(
                "Static marketplace publication requires the System Automations object.",
              );
              const workflow = createRouteBackedAutomationWorkflowRuntime({ object, execution });
              await workflow.createInternalInstance({
                workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                instanceId: `invalid-publication-${scope.kind}`,
                params: { slug: "telegram-test-command", version: "1.0.0" },
              });
            }
          }),
          runner.drain(),
          then.assert(
            "directly created publication workflows fail before publishing",
            async (ctx) => {
              const scopes: BackofficeContextScope[] = [
                { kind: "org", orgId: "org-1" },
                { kind: "project", orgId: "org-1", projectId: ctx.vars.projectId },
                { kind: "user", userId: "owner-1" },
              ];
              for (const scope of scopes) {
                const workflow = createRouteBackedAutomationWorkflowRuntime({
                  object: ctx.runtime.objects.automations.for(scope),
                  execution: createBackofficeSystemExecution(scope),
                });
                const instance = await workflow.getInternalInstance({
                  workflowName: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
                  instanceId: `invalid-publication-${scope.kind}`,
                });
                expect(instance.details).toMatchObject({
                  status: "errored",
                  error: {
                    name: "NonRetryableError",
                    message:
                      "Marketplace publication workflows require the System Automations object.",
                  },
                });
              }
              await expect(
                ctx.runtime.objects.marketplace.singleton().commands.getArtifactManifest({
                  listingId: "system#telegram-test-command",
                }),
              ).resolves.toBeNull();
            },
          ),
        ],
      }),
    );
  });

  test("System context still requires internal.manage authorization", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "System publication retains maintenance authorization",
        setup: ({ given }) => [given.auth.user({ id: "user-1", email: "user@example.com" })],
        steps: ({ then }) => [
          then.assert("an unprivileged System user cannot publish", async (ctx) => {
            const context = createRouteBackedRuntimeContext({
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeUserExecution({
                scope: { kind: "system" },
                userId: "user-1",
              }),
              billingOrganizationId: null,
            });
            assert(context.stateBackend);
            const { bash } = createInteractiveBashHost({
              context: { ...context, stateBackend: context.stateBackend },
            });
            const result = await bash.exec("internal.marketplace.push --format json");
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("Required permission: internal.manage.");
            await expect(
              executeBackofficeRuntimeTool(
                internalMarketplaceToolFamily.tools[0],
                {},
                createBackofficeToolContext(context),
              ),
            ).rejects.toThrow("Required permission: internal.manage.");
            await expect(
              ctx.runtime.objects.marketplace.singleton().commands.getArtifactManifest({
                listingId: "system#telegram-test-command",
              }),
            ).resolves.toBeNull();
          }),
        ],
      }),
    );
  });
});
