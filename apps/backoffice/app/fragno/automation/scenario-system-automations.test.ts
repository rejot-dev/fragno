import { describe, expect, test, assert } from "vitest";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createStateShellFileSystem } from "@/fragno/runtime-tools/state-shell-file-system";

import { ApiObject } from "../../../workers/api-object";
import { AppInstallationsObject } from "../../../workers/app-installations-object";
import { AppsObject } from "../../../workers/apps-object";
import { AuthObject } from "../../../workers/auth-object";
import { AutomationsObject } from "../../../workers/automations-object";
import { BillingObject } from "../../../workers/billing-object";
import { CodemodeObject } from "../../../workers/codemode-object";
import { McpObject } from "../../../workers/mcp-object";
import { OtpObject } from "../../../workers/otp-object";
import { ResendObject } from "../../../workers/resend-object";
import { TelegramObject } from "../../../workers/telegram-object";
import { UploadObject } from "../../../workers/upload-object";
import { createRouteBackedAutomationRouterRuntime } from "./routing-route-runtime";
import { backofficeFiles, defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  BILLING: (input) => new BillingObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  MCP: (input) => new McpObject(input),
  OTP: (input) => new OtpObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
} satisfies LocalBackofficeObjects;

function createScopedTestFileSystem(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
) {
  return createStateShellFileSystem(
    createRuntimeStateBackend({
      runtime: runtime.services,
      kernel: new BackofficeKernel(runtime.services),
      execution,
    }),
  );
}

describe("system automation scenarios", () => {
  test("sign-up and organization creation reach automation ingestion through transactional auth hooks", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "sign-up and organization creation run trigger-backed durable hooks",
        files: backofficeFiles.systemOnly(),
        vars: () => ({ cookie: "", organizationId: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "triggered-user@example.com",
            captureSessionCookieAs: "cookie",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.cookie,
            name: "Triggered Workspace",
            slug: "triggered-workspace",
            captureOrganizationIdAs: "organizationId",
          }),
          then.assert("user and organization hooks completed", async (ctx) => {
            const organizations = await ctx.runtime.objects.auth
              .singleton()
              .commands.getDevOrganizations();
            expect(organizations).toHaveLength(1);
            const organization = organizations[0];
            assert(organization?.id === ctx.vars.organizationId);
            ctx.rememberOrg(organization.id);

            const queue = await ctx.runtime.objects.auth
              .singleton()
              .commands.getDurableHookQueue({ pageSize: 100 });
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: `user.created:${organization.createdBy}`,
                  hookName: "onUserCreated",
                  status: "completed",
                }),
                expect.objectContaining({
                  id: `organization.created:${organization.id}`,
                  hookName: "onOrganizationCreated",
                  status: "completed",
                }),
              ]),
            );
          }),
          then.assert("the triggered organization event reached Automations", async (ctx) => {
            const organizationId = ctx.vars.organizationId;
            assert(organizationId);

            const response = await ctx.runtime.objects.automations
              .singleton()
              .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
            assert(response.ok);
            const result = (await response.json()) as {
              events: Array<{ id: string; eventType: string; subject: unknown }>;
            };
            expect(result.events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: `organization.created:${organizationId}`,
                  eventType: "organization.created",
                  subject: { scope: { kind: "org", orgId: organizationId, jurisdiction: null } },
                }),
              ]),
            );
          }),
          // System's first event: its starter routes must be in place before it takes any.
          then.assert("System forwarded the organization its creation", async (ctx) => {
            const organizationId = ctx.vars.organizationId;
            assert(organizationId);

            const response = await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: organizationId, jurisdiction: null })
              .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
            assert(response.ok);
            const result = (await response.json()) as {
              events: Array<{ eventType: string }>;
            };
            expect(result.events.map((event) => event.eventType)).toContain("organization.created");
          }),
        ],
      }),
    );
  });

  test("System seeds its starter routes again after a failed seed, before it takes the event", async () => {
    // The first read of the seeded revision fails, as storage can, once.
    let failSeed = true;
    const failingSeedObjects = {
      ...scenarioObjects,
      AUTOMATIONS: (input) => {
        const storage = input.state.storage;
        const get = storage.get.bind(storage);
        storage.get = (async (key: string | string[], options?: DurableObjectGetOptions) => {
          if (failSeed && key === "automations:starter-routes-revision") {
            failSeed = false;
            throw new Error("Storage failed once.");
          }
          return Array.isArray(key) ? await get(key, options) : await get(key, options);
        }) as typeof storage.get;
        return new AutomationsObject(input);
      },
    } satisfies LocalBackofficeObjects;

    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: failingSeedObjects,
        name: "System seeds its starter routes again after a failed seed",
        files: backofficeFiles.systemOnly(),
        vars: () => ({ cookie: "", organizationId: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "seed-retry@example.com",
            captureSessionCookieAs: "cookie",
          }),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.cookie,
            name: "Seed Retry",
            slug: "seed-retry",
            captureOrganizationIdAs: "organizationId",
          }),
          // Auth retries the event the failed seed rejected.
          when.time.advance("1 minute"),
          then.assert("System forwarded the organization its creation", async (ctx) => {
            assert(!failSeed);
            const response = await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: ctx.vars.organizationId, jurisdiction: null })
              .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
            assert(response.ok);
            const result = (await response.json()) as { events: Array<{ eventType: string }> };
            expect(result.events.map((event) => event.eventType)).toContain("organization.created");
          }),
        ],
      }),
    );
  });

  test("project creation exposes an empty database-backed workspace", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        objects: scenarioObjects,
        name: "project creation exposes an empty database-backed workspace",
        files: backofficeFiles.systemOnly(),
        vars: () => ({ projectId: "" }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
          given.router.route({
            orgId: "org-1",
            id: "system-project-files-configure",
            name: "Configure project files",
            enabled: true,
            trigger: {
              kind: "event",
              source: "automations",
              eventType: "project.created",
              matcher: null,
            },
            priority: 15,
            action: {
              kind: "start_workflow",
              authority: {
                kind: "organization-automation",
                grants: [BACKOFFICE_PERMISSION.internal.manage],
              },
              workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
              instanceIdTemplate: "project-files-configure-${event.id}",
            },
          }),
        ],

        steps: ({ when, then }) => [
          when.project.create({
            owner: { kind: "org", orgId: "org-1", jurisdiction: null },
            slug: "alpha-project",
            name: "Alpha Project",
            createdByUserId: "user-1",
            captureIdAs: "projectId",
          }),

          then.assert("project workspace is available without seeded files", async (ctx) => {
            const fs = createScopedTestFileSystem(
              ctx.runtime,
              createBackofficeSystemExecution({
                kind: "project",
                owner: { kind: "org", orgId: "org-1", jurisdiction: null },
                projectId: ctx.vars.projectId,
              }),
            );
            await expect(fs.readdir("/workspace")).resolves.toEqual([]);
            await fs.writeFile("/workspace/notes.txt", "project notes");
            await expect(fs.readFile("/workspace/notes.txt")).resolves.toBe("project notes");
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
          then.hooks.noPending({ orgId: "org-1", fragments: ["automations"] }),
          then.hooks.noFailed({ orgId: "org-1", fragments: ["automations"] }),
        ],
      }),
    );
  });

  test("a scenario's workspace files are the files a project's shell reads", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<{ projectId: string }>({
        objects: scenarioObjects,
        name: "workspace files reach a project's shell",
        files: backofficeFiles.workspace(),
        vars: () => ({ projectId: "" }),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
        ],

        steps: ({ when, then }) => [
          when.project.create({
            owner: { kind: "org", orgId: "org-1", jurisdiction: null },
            slug: "alpha-project",
            name: "Alpha Project",
            createdByUserId: "user-1",
            captureIdAs: "projectId",
          }),
          then.assert("the project's shell reads what the scenario wrote", async (ctx) => {
            const scope = {
              kind: "project",
              owner: { kind: "org", orgId: "org-1", jurisdiction: null },
              projectId: ctx.vars.projectId,
            } as const;
            await ctx.files.forProject(scope).writeFile("/workspace/notes.txt", "project notes");

            const { result } = await ctx.runCodemode({
              scope,
              code: `async () => await state.readFile({ path: "/workspace/notes.txt" })`,
            });
            expect(result).toBe("project notes");
          }),
        ],
      }),
    );
  });

  test("auth organization.created reaches an organization with an empty workspace", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "system organization creation leaves the workspace to the organization",
        options: { allowErroredWorkflows: true },

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [
          given.auth.user({
            id: "user-1",
            email: "ada@example.com",
          }),
          given.auth.user({
            id: "scenario-user",
            email: "scenario-user@example.com",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
            ownerRoles: ["owner"],
          }),
          given.auth.member({
            orgId: "org-1",
            userId: "scenario-user",
            roles: ["member"],
          }),
        ],

        steps: ({ when, then }) => [
          when.auth.organizationCreated({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
            ownerEmail: "ada@example.com",
          }),

          then.automation.event({
            scope: { kind: "system" },
            where: {
              id: "auth:organization.created:org-1",
            },
            expected: {
              scopeRestriction: null,
              scope: { kind: "system" },
              source: "auth",
              eventType: "organization.created",
              actors: {
                initiator: {
                  scope: "internal",
                  type: "user",
                  id: "user-1",
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
              subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
            },
          }),
          then.router.missing({ orgId: "org-1", id: "system-project-files-configure" }),

          then.files.missing({ orgId: "org-1", path: "/workspace/AGENTS.md" }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/system.d.ts",
            text: "declare",
          }),
          then.auth.authority({
            userId: "scenario-user",
            orgId: "org-1",
            expected: {
              active: true,
              role: "user",
              organizationMember: true,
            },
          }),
          then.auth.member({
            orgId: "org-1",
            userId: "scenario-user",
            roles: ["member"],
          }),
          then.auth.permissions({
            userId: "scenario-user",
            scope: { kind: "org", orgId: "org-1", jurisdiction: null },
            include: [BACKOFFICE_PERMISSION.store.modify],
            exclude: [BACKOFFICE_PERMISSION.identity.bind],
          }),
          then.assert(
            "members can edit workspace files and inspect hooks through dashboard bash",
            async (ctx) => {
              const orgId = "org-1";
              const kernel = new BackofficeKernel({
                authorityResolver: ctx.runtime.services.authorityResolver,
                kernelObserver: noopBackofficeKernelObserver,
              });
              const execution = createBackofficeUserExecution({
                scope: { kind: "org", orgId, jurisdiction: null },
                userId: "scenario-user",
              });
              const fs = createScopedTestFileSystem(ctx.runtime, execution);
              const { bash } = await createInteractiveBashHost({
                context: createCodemodeRouteBackedRuntimeContext({
                  emitter: { kind: "caller" },
                  runtime: ctx.runtime.services,
                  kernel,
                  execution,
                }),
              });

              const roots = await bash.exec("ls /", { cwd: "/" });
              expect(roots.exitCode, roots.stderr).toBe(0);
              expect(roots.stdout.trim().split(/\s+/u)).toEqual(["shared", "static", "workspace"]);
              for (const path of [
                "/events",
                "/resend",
                "/projects",
                "/tmp",
                "/r2",
                "/r2-remote",
                "/dev",
              ]) {
                await expect(fs.exists(path)).resolves.toBe(false);
              }

              const result = await bash.exec(
                "echo 'writable: true' > /workspace/automations/writable-check.workflow.js",
                { cwd: "/" },
              );
              assert(result.exitCode === 0);

              const listResult = await bash.exec("hooks.list --fragment automations --format json");
              assert(listResult.exitCode === 0, listResult.stderr);
              const queue = JSON.parse(listResult.stdout) as {
                items: Array<{ id: string; hookName: string }>;
              };
              expect(queue.items).toContainEqual(
                expect.objectContaining({
                  id: "org:auth:organization.created:org-1",
                  hookName: "internalIngestEvent",
                }),
              );

              const getResult = await bash.exec(
                "hooks.get --fragment automations --hook-id org:auth:organization.created:org-1 --format json",
              );
              assert(getResult.exitCode === 0, getResult.stderr);
              expect(JSON.parse(getResult.stdout)).toMatchObject({
                id: "org:auth:organization.created:org-1",
                hookName: "internalIngestEvent",
                status: "completed",
              });
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

  test("auth organization.updated is forwarded to the org automation queue after creation", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "production auth organization updates enqueue organization automation events after creation bootstrap",

        files: backofficeFiles.systemOnly(),

        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
        ],

        steps: ({ runner, then }) => [
          then.assert(
            "ingest auth creation through the singleton auth dispatch path",
            async (ctx) => {
              await ctx.runtime.objects.automations.singleton().commands.ingestEvent({
                id: "auth:organization.created:org-1",
                scopeRestriction: null,
                scope: { kind: "system" },
                source: "auth",
                eventType: "organization.created",
                occurredAt: "2026-01-01T00:00:00.000Z",
                sequence: null,
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
                actors: {
                  initiator: {
                    scope: "internal",
                    type: "user",
                    id: "user-1",
                    role: "initiator",
                  },
                  principal: null,
                  delegation: [],
                },
                subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
                causation: { kind: "origin" },
              });
            },
          ),

          runner.drain(),

          then.assert("ingest auth update through regular singleton routing", async (ctx) => {
            await ctx.runtime.objects.automations.singleton().commands.ingestEvent({
              id: "auth:organization.updated:org-1",
              scopeRestriction: null,
              scope: { kind: "system" },
              source: "auth",
              eventType: "organization.updated",
              occurredAt: "2026-01-01T00:01:00.000Z",
              sequence: null,
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
              actors: {
                initiator: {
                  scope: "internal",
                  type: "user",
                  id: "user-1",
                  role: "initiator",
                },
                principal: null,
                delegation: [],
              },
              subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
              causation: { kind: "origin" },
            });
          }),

          runner.drain(),

          then.assert(
            "the organization automations object receives the forwarded update event",
            async (ctx) => {
              const queue = await ctx.runtime.objects.automations
                .for({ kind: "org", orgId: "org-1", jurisdiction: null })
                .commands.getDurableHookQueue("automation", { pageSize: 20 });

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

  test("seeding removes the retired workspace initialization route from the system scope", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a deployment seeded before the route retired drops it",
        files: backofficeFiles.systemOnly(),
        steps: ({ then }) => [
          then.assert("the system scope holds the route from before", async (ctx) => {
            const router = createRouteBackedAutomationRouterRuntime({
              object: ctx.runtime.objects.automations.singleton(),
              execution: createBackofficeSystemExecution({ kind: "system" }),
            });
            await router.createRoute({
              id: "system-workspace-file-initialization",
              name: "Initialize workspace files",
              enabled: true,
              trigger: {
                kind: "event",
                source: "auth",
                eventType: "organization.created",
                matcher: null,
              },
              priority: 10,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: [] },
                workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
                instanceIdTemplate: "workspace-file-initialization-${event.id}",
              },
            });

            const seeded = await ctx.runtime.objects.automations
              .singleton()
              .commands.seedStarterAutomationRoutes();

            expect(seeded.removed).toEqual(["system-workspace-file-initialization"]);
            await expect(
              router.getRoute({ id: "system-workspace-file-initialization" }),
            ).resolves.toBeNull();
          }),
        ],
      }),
    );
  });

  test("an organization creation the retired route matched before it retired settles as skipped", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "a dispatch queued for the retired workspace initialization route",
        files: backofficeFiles.systemOnly(),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs", ownerUserId: "user-1" }),
        ],
        steps: ({ runner, then }) => [
          then.assert("the route from before matches an organization's creation", async (ctx) => {
            await createRouteBackedAutomationRouterRuntime({
              object: ctx.runtime.objects.automations.singleton(),
              execution: createBackofficeSystemExecution({ kind: "system" }),
            }).createRoute({
              id: "system-workspace-file-initialization",
              name: "Initialize workspace files",
              enabled: true,
              trigger: {
                kind: "event",
                source: "auth",
                eventType: "organization.created",
                matcher: null,
              },
              priority: 10,
              action: {
                kind: "start_workflow",
                authority: { kind: "organization-automation", grants: [] },
                workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
                instanceIdTemplate: "workspace-file-initialization-${event.id}",
              },
            });
            await ctx.runtime.objects.automations.singleton().commands.ingestEvent({
              id: "auth:organization.created:org-1",
              scopeRestriction: null,
              scope: { kind: "system" },
              source: "auth",
              eventType: "organization.created",
              occurredAt: "2026-01-01T00:00:00.000Z",
              sequence: null,
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
              actors: {
                initiator: { scope: "internal", type: "user", id: "user-1", role: "initiator" },
                principal: null,
                delegation: [],
              },
              subject: { scope: { kind: "org", orgId: "org-1", jurisdiction: null } },
              causation: { kind: "origin" },
            });
          }),
          runner.drain(),
          // The dispatch holds the route as it matched; its workflow script is gone.
          then.assert(
            "the retired route skipped, and the organization got its creation",
            async (ctx) => {
              const response = await ctx.runtime.objects.automations
                .singleton()
                .http.fetch(
                  new Request("https://automations.test/api/automations/events?limit=500"),
                );
              const { events } = automationEventListResultSchema.parse(await response.json());
              expect(
                events.find((event) => event.id === "auth:organization.created:org-1"),
              ).toMatchObject({
                routing: {
                  status: "matched",
                  routes: [
                    {
                      routeId: "system-auth-organization-created-forward-to-org",
                      status: "completed",
                      outcome: { kind: "event_forwarded" },
                    },
                    {
                      routeId: "system-workspace-file-initialization",
                      status: "completed",
                      outcome: { kind: "skipped", reason: "route_retired" },
                      failedAttempts: 0,
                    },
                  ],
                },
              });
            },
          ),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("configured capabilities expose codemode types from /static on demand", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "configured capabilities expose generated static codemode types",

        files: backofficeFiles.systemOnly(),

        fakes: ({ fake }) => ({
          telegram: fake.telegram(),
        }),

        setup: ({ given, runner }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.telegram.configured({
            orgId: "org-1",
            botUsername: "fragno_bot",
          }),
          runner.drain(),
        ],

        steps: ({ then }) => [
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/hooks.d.ts",
            text: "declare const hooks",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/state.d.ts",
            text: "createUploadLink(input: StateCreateUploadLinkInput)",
          }),
          then.files.contains({
            orgId: "org-1",
            path: "/static/codemode/providers/integrations.d.ts",
            text: "declare const integrations",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });
});
