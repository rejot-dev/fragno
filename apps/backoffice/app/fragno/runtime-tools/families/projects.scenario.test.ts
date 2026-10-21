import { assert, describe, expect, test, vi } from "vitest";

import type { ProjectPage } from "@fragno-dev/backoffice-api/v0/projects";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { Cursor } from "@fragno-dev/db";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  createBackofficeUserExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { runBackofficeCodemode } from "@/fragno/codemode/execute";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryMcpObject } from "../../../../workers/mcp.do";
import { InMemoryTelegramObject } from "../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { projectsToolFamily } from "./projects";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  RESEND: null,
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const organization: BackofficeContextScope = { kind: "org", orgId: "acme" };
const personal: BackofficeContextScope = { kind: "user", userId: "member" };

function projectContext(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  return createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution,
    billingOrganizationId: null,
  });
}

async function terminal(context: ReturnType<typeof projectContext>) {
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
  ).bash;
}

async function projects(ctx: BackofficeScenarioContext, scope: BackofficeContextScope) {
  const response = await createAutomationsRouteCaller({
    object: ctx.runtime.objects.automations.for(scope),
  })("GET", "/projects");
  assert(response.type === "json");
  assert.equal(response.status, 200);
  return response.data.projects;
}

describe("project runtime scenarios", () => {
  test("Bash and Codemode create projects in their selected owners without accepting a creator", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "project creation through runtime tools",
        vars: () => ({ organizationProjectId: "", personalProjectId: "" }),
        setup: ({ given }) => [
          given.auth.user({ id: "owner" }),
          given.auth.user({ id: "member" }),
          given.auth.organization({ id: "acme", ownerUserId: "owner" }),
          given.auth.member({ orgId: "acme", userId: "member", roles: ["member"] }),
        ],
        steps: ({ then }) => [
          then.assert("a member creates an organization project through Bash", async (ctx) => {
            const bash = await terminal(
              projectContext(
                ctx,
                createBackofficeUserExecution({ scope: organization, userId: "member" }),
              ),
            );
            const result = await bash.exec(
              'projects.create --name "Customer Support" --format json',
            );
            assert.equal(result.exitCode, 0, result.stderr);
            const created = JSON.parse(result.stdout) as { projectId: string; slug: string };
            expect(created).toEqual({ projectId: expect.any(String), slug: "customer-support" });
            ctx.vars.organizationProjectId = created.projectId;
            expect(await projects(ctx, organization)).toMatchObject([
              {
                projectId: created.projectId,
                slug: "customer-support",
                name: "Customer Support",
                description: null,
                createdByUserId: "member",
                archivedAt: null,
              },
            ]);
            const queue = await ctx.runtime.objects.automations
              .for(organization)
              .commands.getDurableHookQueue("automation");
            expect(queue.items).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  hookName: "internalIngestEvent",
                  payload: expect.objectContaining({
                    event: expect.objectContaining({
                      eventType: "project.created",
                      scope: organization,
                      subject: { orgId: "acme", projectId: created.projectId },
                    }),
                  }),
                }),
              ]),
            );
          }),
          then.assert("Codemode can reuse the slug in the user's own scope", async (ctx) => {
            const context = projectContext(
              ctx,
              createBackofficeUserExecution({ scope: personal, userId: "member" }),
            );
            const result = await runBackofficeCodemode({
              code: `async () => await projects.create({ name: "My Support", slug: "customer-support", description: "Personal workflows" })`,
              codemode: codemodeRunnerFor(
                ctx.runtime.objects.codemode.for(personal).commands,
                context.execution,
                null,
              ),
              families: runtimeToolFamilies,
              toolContext: createBackofficeToolContext(context),
            });
            assert(!result.error, result.error ?? "Codemode failed");
            const created = result.result as { projectId: string; slug: string };
            expect(created).toEqual({ projectId: expect.any(String), slug: "customer-support" });
            ctx.vars.personalProjectId = created.projectId;
            expect(await projects(ctx, personal)).toMatchObject([
              {
                projectId: created.projectId,
                name: "My Support",
                description: "Personal workflows",
                createdByUserId: "member",
              },
            ]);
          }),
          then.assert(
            "conflicts and invalid or forged input leave the projects unchanged",
            async (ctx) => {
              const context = projectContext(
                ctx,
                createBackofficeUserExecution({ scope: organization, userId: "member" }),
              );
              const bash = await terminal(context);
              const duplicate = await bash.exec('projects.create --name "Customer Support"');
              assert.equal(duplicate.exitCode, 1);
              expect(duplicate.stderr).toContain("409");
              for (const command of [
                'projects.create --name ""',
                "projects.create --name Invalid --slug INVALID",
                "projects.create --name Forged --created-by-user-id owner",
              ]) {
                assert.equal((await bash.exec(command)).exitCode, 1);
              }
              await expect(
                executeBackofficeRuntimeTool(
                  projectsToolFamily.tools[0],
                  { name: "Forged", createdByUserId: "owner" },
                  createBackofficeToolContext(context),
                ),
              ).rejects.toThrow();
              expect((await projects(ctx, organization)).map(({ projectId }) => projectId)).toEqual(
                [ctx.vars.organizationProjectId],
              );
              expect((await projects(ctx, personal)).map(({ projectId }) => projectId)).toEqual([
                ctx.vars.personalProjectId,
              ]);
            },
          ),
        ],
      }),
    );
  });

  test("lists owner-isolated pages through Bash and Codemode, including archived projects", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "project listings paginate by slug",
        vars: () => ({ cursor: "", archivedProjectId: "" }),
        setup: ({ given }) => [
          given.auth.user({ id: "owner" }),
          given.auth.user({ id: "member" }),
          given.auth.organization({ id: "acme", ownerUserId: "owner" }),
          given.auth.member({ orgId: "acme", userId: "member", roles: ["member"] }),
        ],
        steps: ({ when, then }) => [
          then.assert("an empty owner has a terminal page", async (ctx) => {
            const bash = await terminal(
              projectContext(
                ctx,
                createBackofficeUserExecution({ scope: organization, userId: "member" }),
              ),
            );
            const result = await bash.exec("projects.list --format json");
            assert.equal(result.exitCode, 0, result.stderr);
            expect(JSON.parse(result.stdout)).toEqual({
              projects: [],
              nextCursor: null,
              hasNextPage: false,
            });
            expect((await bash.exec("projects.list")).stdout).toContain("No projects found.");
          }),
          when.project.create({ owner: organization, name: "Zulu", createdByUserId: "owner" }),
          when.project.create({
            owner: organization,
            name: "Beta",
            createdByUserId: "owner",
            captureIdAs: "archivedProjectId",
          }),
          when.project.create({
            owner: organization,
            name: "Alpha",
            description: "First by slug",
            createdByUserId: "member",
          }),
          when.project.create({
            owner: personal,
            name: "Alpha",
            description: "Private",
            createdByUserId: "member",
          }),
          then.assert("Bash returns the first page in slug order with public IDs", async (ctx) => {
            const bash = await terminal(
              projectContext(
                ctx,
                createBackofficeUserExecution({ scope: organization, userId: "member" }),
              ),
            );
            const result = await bash.exec("projects.list --page-size 1 --format json");
            assert.equal(result.exitCode, 0, result.stderr);
            const page = JSON.parse(result.stdout) as ProjectPage;
            expect(page).toEqual({
              projects: [
                {
                  projectId: expect.any(String),
                  slug: "alpha",
                  name: "Alpha",
                  description: "First by slug",
                  archivedAt: null,
                  createdByUserId: "member",
                  createdAt: expect.any(String),
                  updatedAt: expect.any(String),
                },
              ],
              nextCursor: expect.any(String),
              hasNextPage: true,
            });
            assert(page.nextCursor);
            ctx.vars.cursor = page.nextCursor;
          }),
          then.assert("archiving a project between pages does not hide it", async (ctx) => {
            const archived = await createAutomationsRouteCaller({
              object: ctx.runtime.objects.automations.for(organization),
            })("DELETE", "/projects/:projectId", {
              pathParams: { projectId: ctx.vars.archivedProjectId },
            });
            assert(archived.type === "json");
            const context = projectContext(
              ctx,
              createBackofficeUserExecution({ scope: organization, userId: "member" }),
            );
            const run = await runBackofficeCodemode({
              code: `async () => {
                const second = await projects.list({ pageSize: 1, cursor: ${JSON.stringify(ctx.vars.cursor)} });
                const last = await projects.list({ pageSize: 1, cursor: second.nextCursor });
                return { second, last };
              }`,
              codemode: codemodeRunnerFor(
                ctx.runtime.objects.codemode.for(organization).commands,
                context.execution,
                null,
              ),
              families: runtimeToolFamilies,
              toolContext: createBackofficeToolContext(context),
            });
            assert(!run.error, run.error ?? "Codemode failed");
            expect(run.result).toMatchObject({
              second: {
                projects: [
                  {
                    projectId: ctx.vars.archivedProjectId,
                    slug: "beta",
                    archivedAt: expect.any(String),
                  },
                ],
                nextCursor: expect.any(String),
                hasNextPage: true,
              },
              last: { projects: [{ slug: "zulu" }], nextCursor: null, hasNextPage: false },
            });
            const rendered = await (await terminal(context)).exec("projects.list");
            assert.equal(rendered.exitCode, 0, rendered.stderr);
            expect(rendered.stdout).toContain(
              `beta\tBeta\t${ctx.vars.archivedProjectId}\tarchived`,
            );
          }),
          then.assert(
            "personal listings never include the organization's projects",
            async (ctx) => {
              const bash = await terminal(
                projectContext(
                  ctx,
                  createBackofficeUserExecution({ scope: personal, userId: "member" }),
                ),
              );
              const result = await bash.exec("projects.list --format json");
              assert.equal(result.exitCode, 0, result.stderr);
              expect(JSON.parse(result.stdout)).toMatchObject({
                projects: [{ slug: "alpha", description: "Private", archivedAt: null }],
                nextCursor: null,
                hasNextPage: false,
              });
            },
          ),
          then.assert(
            "invalid cursors and page sizes are rejected without changing the listing",
            async (ctx) => {
              const context = projectContext(
                ctx,
                createBackofficeUserExecution({ scope: organization, userId: "member" }),
              );
              const bash = await terminal(context);
              const wrongIndex = new Cursor({
                indexName: "_primary",
                orderDirection: "asc",
                pageSize: 1,
                indexValues: { id: "unknown" },
              }).encode();
              const wrongDirection = new Cursor({
                indexName: "idx_project_slug",
                orderDirection: "desc",
                pageSize: 1,
                indexValues: { slug: "alpha" },
              }).encode();
              const wrongValue = new Cursor({
                indexName: "idx_project_slug",
                orderDirection: "asc",
                pageSize: 1,
                indexValues: { slug: 123 },
              }).encode();
              for (const command of [
                "projects.list --cursor invalid",
                `projects.list --page-size 2 --cursor ${ctx.vars.cursor}`,
                `projects.list --page-size 1 --cursor ${wrongIndex}`,
                `projects.list --page-size 1 --cursor ${wrongDirection}`,
                `projects.list --page-size 1 --cursor ${wrongValue}`,
              ]) {
                const result = await bash.exec(command);
                assert.equal(result.exitCode, 1);
                expect(result.stderr).toContain("Invalid project list cursor.");
              }
              for (const command of [
                "projects.list --page-size 0",
                "projects.list --page-size 101",
              ]) {
                assert.equal((await bash.exec(command)).exitCode, 1);
              }
              const result = await bash.exec("projects.list --format json");
              assert.equal(result.exitCode, 0, result.stderr);
              expect(
                (JSON.parse(result.stdout) as ProjectPage).projects.map(({ slug }) => slug),
              ).toEqual(["alpha", "beta", "zulu"]);
            },
          ),
        ],
      }),
    );
  });

  test("scope restrictions and principal authority prevent project creation outside an authorized owner", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "project creation stays inside its authority",
        vars: () => ({ projectId: "" }),
        setup: ({ given }) => [
          given.auth.user({ id: "owner" }),
          given.auth.user({ id: "outsider" }),
          given.auth.organization({ id: "acme", ownerUserId: "owner" }),
        ],
        steps: ({ when, then }) => [
          when.project.create({
            owner: organization,
            name: "Existing",
            createdByUserId: "owner",
            captureIdAs: "projectId",
          }),
          then.assert(
            "nonmembers cannot create in the organization or another user's scope",
            async (ctx) => {
              for (const scope of [organization, { kind: "user", userId: "owner" } as const]) {
                const bash = await terminal(
                  projectContext(ctx, createBackofficeUserExecution({ scope, userId: "outsider" })),
                );
                const denied = await bash.exec("projects.create --name Unauthorized");
                assert.equal(denied.exitCode, 1);
                expect(denied.stderr).toContain("Required permission: projects.create.");
                const deniedList = await bash.exec("projects.list --format json");
                assert.equal(deniedList.exitCode, 1);
                expect(deniedList.stderr).toContain("Required permission: projects.read.");
              }
            },
          ),
          then.assert(
            "project-scoped credentials cannot create siblings or escape to the owner",
            async (ctx) => {
              const scope: BackofficeContextScope = {
                kind: "project",
                owner: organization,
                projectId: ctx.vars.projectId,
              };
              const execution = {
                ...createBackofficeUserExecution({ scope, userId: "owner" }),
                scopeRestriction: scope,
              };
              const context = projectContext(ctx, execution);
              const bash = await terminal(context);
              for (const command of ["projects.create --name Sibling", "projects.list"]) {
                const denied = await bash.exec(command);
                assert.equal(denied.exitCode, 1);
                expect(denied.stderr).toContain("unavailable");
              }
              expect(() => context.createBackofficeScopedContext(organization)).toThrow(
                "Credential scope does not permit",
              );
            },
          ),
          then.assert(
            "system, app workspace, and principal-free contexts do not offer project creation",
            async (ctx) => {
              for (const execution of [
                createBackofficeSystemExecution(organization),
                createBackofficeUserExecution({ scope: { kind: "system" }, userId: "owner" }),
                createBackofficeUserExecution({
                  scope: { kind: "app", owner: organization, appId: "workspace-app" },
                  userId: "owner",
                }),
              ]) {
                const bash = await terminal(projectContext(ctx, execution));
                for (const command of ["projects.create --name Unavailable", "projects.list"]) {
                  const denied = await bash.exec(command);
                  assert.equal(denied.exitCode, 1);
                  expect(denied.stderr).toContain("unavailable");
                }
              }
            },
          ),
          then.assert("all denied attempts leave only the original project", async (ctx) => {
            expect((await projects(ctx, organization)).map(({ projectId }) => projectId)).toEqual([
              ctx.vars.projectId,
            ]);
            expect(await projects(ctx, { kind: "user", userId: "owner" })).toEqual([]);
          }),
        ],
      }),
    );
  });
});
