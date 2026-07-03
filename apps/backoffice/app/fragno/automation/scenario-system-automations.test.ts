import { describe, expect, test, vi, assert } from "vitest";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  createBackofficeFileSystem,
  createMasterFileSystem,
  createSystemFilesContext,
} from "@/files";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import type { AutomationEvent } from "./contracts";
import { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";

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

vi.mock("cloudflare:workers", () => ({
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
}));

import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const systemUnrelatedEvent = {
  id: "github:issue.opened:1",
  scope: { kind: "org", orgId: "org-1" },
  source: "github",
  eventType: "issue.opened",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    issueId: "issue-1",
  },
  actor: {
    scope: "external",
    source: "github",
    type: "user",
    id: "octocat",
  },
  actors: [
    {
      scope: "external",
      source: "github",
      type: "user",
      id: "octocat",
    },
  ],
  subject: { orgId: "org-1" },
} satisfies AutomationEvent;

describe("system automation scenarios", () => {
  test("auth organization.created initializes upload-backed workspace files", async () => {
    const orgId = "org-real";
    let runtime!: InMemoryBackofficeRuntime;
    runtime = await createInMemoryBackofficeRuntime({
      getAutomationFileSystem: async ({ execution }) =>
        await createMasterFileSystem(
          createSystemFilesContext({
            objects: runtime.objects,
            execution,
            staticFileArtifacts: createCodemodeStaticArtifactsResolver({
              objects: runtime.objects,
              config: runtime.config,
              execution,
            }),
          }),
        ),
    });

    try {
      const systemAutomations = runtime.objects.automations.singleton();
      await systemAutomations.ingestEvent({
        id: `system:auth:organization.created:${orgId}`,
        scope: { kind: "system" },
        source: "auth",
        eventType: "organization.created",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: {
          organization: {
            id: orgId,
            name: "Ada Labs",
            slug: "ada-labs",
            logoUrl: null,
            metadata: null,
            createdBy: "user-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        },
        actor: {
          scope: "internal",
          type: "user",
          id: "user-1",
          email: "ada@example.com",
          role: "user",
        },
        actors: [
          {
            scope: "internal",
            type: "user",
            id: "user-1",
            email: "ada@example.com",
            role: "user",
          },
        ],
        subject: { orgId },
      } satisfies AutomationEvent);

      await runtime.drain();

      const workflow = createRouteBackedAutomationWorkflowRuntime({
        object: runtime.objects.automations.singleton(),
        scope: { kind: "system" },
      });
      const listInstances = workflow.listInstances;
      if (!listInstances) {
        throw new Error("Workflow listInstances runtime helper is unavailable.");
      }
      const instances = await listInstances({
        workflowName: "automation-codemode-script",
        remoteWorkflowName: "workspace-file-initialization",
      });
      expect(instances.instances).toHaveLength(1);
      assert(instances.instances[0]!.details.status === "complete");

      const systemExecution = {
        actor: { type: "system" as const, id: "system" },
        scope: { kind: "org" as const, orgId },
      };
      const fs = await createBackofficeFileSystem({
        objects: runtime.objects,
        kernel: new BackofficeKernel({ objects: runtime.objects }),
        execution: systemExecution,
        config: runtime.config,
      });
      await expect(fs.readFile("/workspace/AGENTS.md")).resolves.toContain("Workspace guidance");
      await expect(fs.readFile("/static/codemode/providers/capabilities.d.ts")).resolves.toContain(
        "declare const capabilities",
      );

      // Regression: an org member (not root) must be able to edit a seeded
      // workspace automation. Seeded files are group-owned by the org, so the
      // member's group-write bit applies instead of the read-only "other" bits
      // that previously failed their save with EACCES.
      const memberFs = await createMasterFileSystem(
        createSystemFilesContext({
          objects: runtime.objects,
          execution: {
            actor: {
              type: "user",
              id: "user-1",
              userId: "user-1",
              email: "ada@example.com",
              role: "user",
              organizationIds: [orgId],
            },
            scope: { kind: "org", orgId },
          },
          staticFileArtifacts: () => ({}),
        }),
      );
      const telegramPath = "/workspace/automations/telegram-test-command.workflow.js";
      await expect(
        memberFs.writeFile(telegramPath, "// edited by org member\n"),
      ).resolves.toBeUndefined();
      await expect(memberFs.readFile(telegramPath)).resolves.toContain("edited by org member");
    } finally {
      await runtime.cleanup();
    }
  });

  test("project.created initializes db-backed project workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        name: "system project creation initializes project workspace files",
        options: { allowErroredWorkflows: true },

        files: backofficeFiles.systemOnly(),
        vars: () => ({ projectId: "" }),

        setup: ({ given, runner }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
          given.connection.configured({
            orgId: "org-1",
            id: "upload",
            payload: { provider: "database" },
          }),
          runner.drain(),
        ],

        steps: ({ when, runner, then }) => [
          when.router.seedStarter({ orgId: "org-1" }),

          when.project.create({
            orgId: "org-1",
            slug: "alpha-project",
            name: "Alpha Project",
            createdByUserId: "user-1",
            captureIdAs: "projectId",
          }),

          runner.drain(),

          then.assert("project upload database provider is configured", async (ctx) => {
            const config = await ctx.runtime.objects.upload
              .forProject({ orgId: "org-1", projectId: ctx.vars.projectId })
              .getAdminConfig();
            assert(config.providers.database?.configured);
          }),

          then.files.contains({
            orgId: "org-1",
            path: "/projects/alpha-project/README.md",
            text: "Project workspace",
          }),

          then.assert("project README is writable through the org filesystem", async (ctx) => {
            const fs = await createMasterFileSystem(
              createSystemFilesContext({
                objects: ctx.runtime.objects,
                execution: {
                  actor: { type: "system", id: "system" },
                  scope: { kind: "org", orgId: "org-1" },
                },
                staticFileArtifacts: () => ({}),
              }),
            );
            await fs.writeFile(
              "/projects/alpha-project/README.md",
              "# Alpha Project\n\nUpdated through /projects.",
            );
            await expect(fs.readFile("/projects/alpha-project/README.md")).resolves.toContain(
              "Updated through /projects.",
            );
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("auth organization.created initializes workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system organization creation initializes workspace files",
        options: { allowErroredWorkflows: true },

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [
          given.organization.exists({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
          }),
        ],

        steps: ({ when, then }) => [
          when.auth.organizationCreated({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
            ownerEmail: "ada@example.com",
          }),

          then.workflow.instance({
            remoteWorkflowName: "workspace-file-initialization",
            status: "complete",
            output: {
              configured: true,
              id: "upload",
              provider: "database",
            },
          }),

          then.workflow.steps({
            remoteWorkflowName: "workspace-file-initialization",
            include: [
              "configure upload database connection",
              "seed workspace starter files",
              "seed starter automation routes",
            ],
          }),

          then.assert("workspace initialization workflow runs in system scope", async (ctx) => {
            const systemWorkflow = createRouteBackedAutomationWorkflowRuntime({
              object: ctx.runtime.objects.automations.singleton(),
              scope: { kind: "system" },
            });
            const systemInstances = await systemWorkflow.listInstances?.({
              workflowName: "automation-codemode-script",
              remoteWorkflowName: "workspace-file-initialization",
            });

            expect(systemInstances?.instances).toHaveLength(1);
            assert(systemInstances?.instances[0]?.details.status === "complete");
          }),

          then.router.routes({
            orgId: "org-1",
            include: [
              {
                id: "system-project-files-configure",
                source: "automations",
                eventType: "project.created",
                action: {
                  kind: "start_workflow",
                  remoteWorkflowName: "project-files-configure",
                  workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
                },
              },
              {
                id: "telegram-test-command",
                action: {
                  kind: "start_workflow",
                  remoteWorkflowName: "telegram-test-command",
                  workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
                },
              },
            ],
          }),

          then.files.exists({ orgId: "org-1", path: "/workspace/AGENTS.md" }),
          then.files.missing({
            orgId: "org-1",
            path: "/workspace/automations/router.cm.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-linking.workflow.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-user-pi-linking.workflow.js",
          }),
          then.files.exists({
            orgId: "org-1",
            path: "/workspace/automations/telegram-test-command.workflow.js",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/system.d.ts",
            text: "declare",
          }),
          then.assert(
            "workspace automations directory is writable through dashboard bash",
            async (ctx) => {
              const orgId = "org-1";
              const kernel = new BackofficeKernel({
                objects: ctx.runtime.objects,
              });
              const execution = {
                actor: {
                  scope: "internal" as const,
                  type: "user" as const,
                  id: "scenario-user",
                  userId: "scenario-user",
                  organizationIds: [orgId],
                },
                scope: { kind: "org" as const, orgId },
              };
              const fs = await createBackofficeFileSystem({
                objects: ctx.runtime.objects,
                kernel,
                execution,
                config: ctx.runtime.config,
              });
              const { bash } = createInteractiveBashHost({
                fs,
                context: createRouteBackedRuntimeContext({
                  runtime: ctx.runtime.services,
                  kernel,
                  execution,
                  defaultActor: execution.actor,
                }),
              });

              const result = await bash.exec(
                "touch /workspace/automations/writable-check.workflow.js && echo 'writable: true' > /workspace/automations/writable-check.workflow.js",
                { cwd: "/" },
              );
              assert(result.exitCode === 0);
            },
          ),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/automations/writable-check.workflow.js",
            text: "writable: true",
          }),
        ],
      }),
    );
  });

  test("auth organization.updated is forwarded to the org automation queue after creation initializes routes", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "production auth organization updates enqueue organization automation events after creation bootstrap",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
        ],

        steps: ({ runner, then }) => [
          then.assert(
            "ingest auth creation through the singleton auth dispatch path",
            async (ctx) => {
              await ctx.runtime.objects.automations.singleton().ingestEvent({
                id: "auth:organization.created:org-1",
                scope: { kind: "system" },
                source: "auth",
                eventType: "organization.created",
                occurredAt: "2026-01-01T00:00:00.000Z",
                payload: {
                  organization: {
                    id: "org-1",
                    name: "Ada Labs",
                    slug: "ada-labs",
                    logoUrl: null,
                    metadata: null,
                    createdBy: "user-1",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    deletedAt: null,
                  },
                },
                actor: {
                  scope: "internal",
                  type: "user",
                  id: "user-1",
                  email: "ada@example.com",
                  role: "user",
                },
                actors: [
                  {
                    scope: "internal",
                    type: "user",
                    id: "user-1",
                    email: "ada@example.com",
                    role: "user",
                  },
                ],
                subject: { orgId: "org-1" },
              });
            },
          ),

          runner.drain(),

          then.assert("ingest auth update through regular singleton routing", async (ctx) => {
            await ctx.runtime.objects.automations.singleton().ingestEvent({
              id: "auth:organization.updated:org-1",
              scope: { kind: "system" },
              source: "auth",
              eventType: "organization.updated",
              occurredAt: "2026-01-01T00:01:00.000Z",
              payload: {
                organization: {
                  id: "org-1",
                  name: "Ada Labs Updated",
                  slug: "ada-labs",
                  logoUrl: null,
                  metadata: null,
                  createdBy: "user-1",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:01:00.000Z",
                  deletedAt: null,
                },
              },
              actor: {
                scope: "internal",
                type: "user",
                id: "user-1",
                email: "ada@example.com",
                role: "user",
              },
              actors: [
                {
                  scope: "internal",
                  type: "user",
                  id: "user-1",
                  email: "ada@example.com",
                  role: "user",
                },
              ],
              subject: { orgId: "org-1" },
            });
          }),

          runner.drain(),

          then.assert(
            "the organization automations object receives the forwarded update event",
            async (ctx) => {
              const repository = await ctx.runtime.objects.automations
                .forOrg("org-1")
                .getDurableHookRepository("automation");
              const queue = await repository.getHookQueue({ pageSize: 20 });

              expect(queue.items).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    id: "org:auth:organization.updated:org-1",
                    hookName: "internalIngestEvent",
                  }),
                ]),
              );
            },
          ),
        ],
      }),
    );
  });

  test("unrelated system events do not create system workflow instances", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system router ignores unrelated automation events",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.automation.ingestEvent(systemUnrelatedEvent),

          then.workflow.missing({
            remoteWorkflowName: "workspace-file-initialization",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("workspace-file-initialization skips non-organization-created events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "workspace initialization skips non-organization-created events",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],

        steps: ({ when, then }) => [
          when.workflow.createInstance({
            orgId: "org-1",
            remoteWorkflowName: "workspace-file-initialization",
            instanceId: "workspace-file-initialization-skip",
            params: {
              automationEvent: systemUnrelatedEvent,
              workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
            },
          }),

          then.workflow.instance({
            remoteWorkflowName: "workspace-file-initialization",
            instanceId: "workspace-file-initialization-skip",
            status: "complete",
            output: { skipped: true, reason: "not-organization-created" },
          }),
          then.connection.unconfigured({ orgId: "org-1", id: "upload" }),
          then.files.missing({ orgId: "org-1", path: "/workspace/AGENTS.md" }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("configured capabilities expose codemode types from /static on demand", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "configured capabilities expose generated static codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given, runner }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.connection.configured({
            orgId: "org-1",
            id: "upload",
            payload: { provider: "database" },
          }),
          runner.drain(),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          runner.drain(),
        ],

        steps: ({ then }) => [
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/capabilities.d.ts",
            text: "declare const capabilities",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/connections.d.ts",
            text: "declare const connections",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/connections.d.ts",
            text: "configure(input: ConnectionsConfigureInput)",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/telegram.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("installed MCP servers expose codemode provider types from /static on demand", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "installed MCP servers expose generated static codemode provider types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          mcp: fake.mcp({
            servers: [
              {
                slug: "cloudflare-mcp",
                name: "Cloudflare MCP",
                cache: {
                  tools: [
                    {
                      name: "search-docs",
                      description: "Search docs.",
                      inputSchema: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }),

        setup: ({ given, runner }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.connection.configured({
            orgId: "org-1",
            id: "upload",
            payload: { provider: "database" },
          }),
          given.connection.configured({ orgId: "org-1", id: "mcp" }),
          runner.drain(),
        ],

        steps: ({ then }) => [
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/system.d.ts",
            text: "/static/codemode/providers/mcp_cloudflare_mcp.d.ts",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/mcp_cloudflare_mcp.d.ts",
            text: "declare const mcp_cloudflare_mcp",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/mcp_cloudflare_mcp.d.ts",
            text: "search_docs(input: McpCloudflareMcpSearchDocsInput)",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/mcp_cloudflare_mcp.d.ts",
            text: "query: string",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
