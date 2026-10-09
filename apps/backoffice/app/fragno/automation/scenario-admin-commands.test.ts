import { assert, describe, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {},
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryAppsObject } from "../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../workers/forms.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const scenarioObjects = {
  APPS: (input) => new InMemoryAppsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

async function createSystemTerminalBash(ctx: BackofficeScenarioContext) {
  const execution = createBackofficeSystemExecution({ kind: "system" });
  const kernel = new BackofficeKernel(ctx.runtime.services);
  return createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      kernel,
      execution,
      billingOrganizationId: null,
    }),
  }).bash;
}

describe("system admin command scenarios", () => {
  test("shows organization creation help from the system terminal", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "System terminal admin organization help",
        steps: ({ then }) => [
          then.assert("system admin command help is available", async (ctx) => {
            const bash = await createSystemTerminalBash(ctx);
            const roots = await bash.exec("ls /", { cwd: "/" });
            assert.equal(roots.exitCode, 0, roots.stderr);
            assert.deepEqual(roots.stdout.trim().split(/\s+/u), ["static", "system"]);

            const help = await bash.exec("admin.org.create --help");

            assert.equal(help.exitCode, 0, help.stderr);
            assert.match(help.stdout, /admin\.org\.create/u);
          }),
        ],
      }),
    );
  });

  test("creates an organization from the system terminal", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "System terminal admin organization creation",
        steps: ({ given, then }) => [
          given.auth.user({ id: "owner", email: "owner@example.com" }),
          then.assert("system admin organization creation succeeds", async (ctx) => {
            const bash = await createSystemTerminalBash(ctx);
            const created = await bash.exec(
              'admin.org.create --name "Acme" --slug acme --owner-email owner@example.com',
            );

            assert.equal(created.exitCode, 0, created.stderr);
            assert(
              await ctx.runtime.objects.auth.singleton().commands.getOrganizationBySlug("acme"),
            );
          }),
        ],
      }),
    );
  });

  test("administers organization membership by slug from the system terminal", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        objects: scenarioObjects,
        name: "System terminal admin organization membership",
        steps: ({ given, then }) => [
          given.auth.user({ id: "owner", email: "owner@example.com" }),
          given.auth.user({ id: "member", email: "member@example.com" }),
          given.auth.organization({
            id: "org-acme",
            name: "Acme",
            slug: "acme",
            ownerUserId: "owner",
          }),
          then.assert("system admins list, read, and add members by slug", async (ctx) => {
            const bash = await createSystemTerminalBash(ctx);
            const listed = await bash.exec("admin.org.list --print organizations.0.slug");
            assert.equal(listed.exitCode, 0, listed.stderr);
            assert.equal(listed.stdout, "acme\n");
            const read = await bash.exec("admin.org.get --org acme --print organizationId");
            assert.equal(read.exitCode, 0, read.stderr);
            assert.equal(read.stdout, "org-acme\n");

            const invalidRole = await bash.exec(
              "admin.org.members.add --org acme --email member@example.com --role viewer",
            );
            assert.equal(invalidRole.exitCode, 1);
            const added = await bash.exec(
              "admin.org.members.add --org acme --email member@example.com --role admin",
            );
            assert.equal(added.exitCode, 0, added.stderr);
            const members = await bash.exec("admin.org.members.list --org acme --format json");
            assert.equal(members.exitCode, 0, members.stderr);
            assert.sameDeepMembers(
              JSON.parse(members.stdout).members.map(
                ({ email, roles }: { email: string; roles: string[] }) => ({ email, roles }),
              ),
              [
                { email: "owner@example.com", roles: ["owner"] },
                { email: "member@example.com", roles: ["admin"] },
              ],
            );
          }),
        ],
      }),
    );
  });
});
