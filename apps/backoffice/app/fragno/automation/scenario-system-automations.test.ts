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

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

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
          createSystemFilesContext({ objects: runtime.objects, execution }),
        ),
    });

    try {
      await runtime.objects.automations.forOrg(orgId).ingestEvent({
        id: `auth:organization.created:${orgId}`,
        scope: { kind: "org", orgId },
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
        object: runtime.objects.automations.forOrg(orgId),
        scope: { kind: "org", orgId },
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

      const fs = await createMasterFileSystem(
        createSystemFilesContext({ objects: runtime.objects, orgId }),
      );
      await expect(fs.readFile("/workspace/AGENTS.md")).resolves.toContain("Workspace guidance");
      await expect(fs.readFile("/workspace/codemode.d.ts")).resolves.toContain(
        "declare const capabilities",
      );

      const userFs = await createBackofficeFileSystem({
        objects: runtime.objects,
        kernel: new BackofficeKernel({ objects: runtime.objects }),
        execution: {
          actor: {
            type: "user",
            id: "user-1",
            userId: "user-1",
            organizationIds: [orgId],
          },
          scope: { kind: "org", orgId },
        },
      });
      await expect(
        userFs.writeFile("/workspace/automations/bla.txt", "dashboard can write"),
      ).resolves.toBeUndefined();
      await expect(userFs.readFile("/workspace/automations/bla.txt")).resolves.toBe(
        "dashboard can write",
      );
    } finally {
      await runtime.cleanup();
    }
  });

  test("project.created initializes db-backed project workspace files", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        name: "system project creation initializes project workspace files",

        files: backofficeFiles.systemOnly(),
        vars: () => ({ projectId: "" }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
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
              createSystemFilesContext({ objects: ctx.runtime.objects, orgId: "org-1" }),
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
              "write codemode dts",
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
            path: "/workspace/codemode.d.ts",
            text: "declare",
          }),
          then.assert(
            "workspace automations directory is writable through dashboard bash",
            async (ctx) => {
              const orgId = "org-1";
              const kernel = new BackofficeKernel({ objects: ctx.runtime.objects });
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
          then.workflow.noErrored({ orgId: "org-1" }),
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
          then.workflow.missing({
            remoteWorkflowName: "codemode-types-refresh",
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

  test("capability.configured writes missing codemode types", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration writes missing codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-1",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-1",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.workflow.steps({
            instanceId: "codemode-types-refresh-telegram-capability-1",
            include: ["sync codemode dts"],
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const capabilities",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const connections",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "configure(input: ConnectionsConfigureInput)",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("mcp server configuration changes write installed MCP codemode provider types", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system MCP server configuration writes codemode provider types",

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

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.connection.configured({ orgId: "org-1", id: "mcp" }),
        ],

        steps: ({ when, then }) => [
          when.automation.ingestEvent({
            id: "mcp-server-changed-1",
            scope: { kind: "org", orgId: "org-1" },
            source: "mcp",
            eventType: "server.configuration.changed",
            occurredAt: "2026-01-01T00:00:00.000Z",
            payload: {
              serverId: "cloudflare-mcp",
              current: { tools: [{ name: "search-docs" }] },
            },
            actor: { scope: "internal", type: "system", id: "mcp" },
            actors: [{ scope: "internal", type: "system", id: "mcp" }],
            subject: { orgId: "org-1", serverId: "cloudflare-mcp" },
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-mcp-server-changed-1",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "// ── Installed MCP tool providers",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const mcp_cloudflare_mcp",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "search_docs(input: McpCloudflareMcpSearchDocsInput)",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "query: string",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("capability.configured overwrites stale codemode types", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration overwrites stale codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          given.direct.file({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            content: "stale codemode types",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-stale",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-stale",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "Generated by Backoffice system automation",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("capability.configured leaves identical codemode types unchanged", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "system capability configuration keeps identical codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
        ],

        steps: ({ when, then }) => [
          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-first",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-first",
            status: "complete",
            output: {
              changed: true,
              path: "/workspace/codemode.d.ts",
            },
          }),

          when.capability.configured({
            orgId: "org-1",
            source: "telegram",
            capabilityId: "telegram",
            capabilityLabel: "Telegram",
            eventId: "telegram-capability-second",
          }),

          then.workflow.instance({
            instanceId: "codemode-types-refresh-telegram-capability-second",
            status: "complete",
            output: {
              changed: false,
              path: "/workspace/codemode.d.ts",
            },
          }),
          then.workflow.steps({
            instanceId: "codemode-types-refresh-telegram-capability-second",
            include: ["sync codemode dts"],
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/workspace/codemode.d.ts",
            text: "declare const telegram",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
