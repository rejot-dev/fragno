import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { entitlementInScope } from "@/fragno/entitlements/entitlements.server";
import { isFeatureEnabledInScope } from "@/fragno/feature-flags/feature-flags.server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { OverridesObject } from "../../../../workers/overrides-object";
import type { AdminOverride } from "./admin-overrides";

const objects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  OVERRIDES: (input) => new OverridesObject(input),
} satisfies LocalBackofficeObjects;

const feature = "organization-access-summary";
const acme = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const website = "project:org:acme:website";
const person = { kind: "user", userId: "user-1", jurisdiction: null } as const;

const assistant = {
  scope: "internal",
  type: "agent",
  id: "admin-assistant",
  role: "assistant",
} as const;

/**
 * A System terminal for `userId`; with `assistantGrants`, an assistant acts for them, granted
 * only those permissions.
 */
async function terminal(
  ctx: BackofficeScenarioContext,
  userId: string,
  assistantGrants: readonly BackofficePermissionRequirement[] | null = null,
) {
  const execution = createBackofficeUserExecution({ scope: { kind: "system" }, userId });
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel({
      ...ctx.runtime.services,
      authorityResolver: assistantGrants
        ? withBackofficeActorCapabilityGrants({
            resolver: ctx.runtime.services.authorityResolver,
            actor: assistant,
            grants: assistantGrants,
          })
        : ctx.runtime.services.authorityResolver,
    }),
    execution: assistantGrants
      ? { ...execution, actors: { ...execution.actors, delegation: [assistant] } }
      : execution,
  });
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
  ).bash;
}

async function flag(
  ctx: BackofficeScenarioContext,
  command: string,
  scope: string,
): Promise<AdminOverride> {
  const bash = await terminal(ctx, "admin-1");
  const result = await bash.exec(
    `admin.feature-flags.${command} --scope ${scope} --key ${feature} --format json`,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("feature flags resolve the most specific override on a scope's chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "backoffice-overrides-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "feature flag overrides across system, organization, and project scopes",
        objects,
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.auth.user({ id: "user-1", role: "user" }),
          given.organization.exists({ id: acme.orgId, slug: "acme" }),
          given.organization.exists({ id: "org-2", slug: "other" }),
          given.featureFlag({ scope: { kind: "system" }, key: feature, enabled: false }),
        ],
        steps: ({ then, runner }) => [
          then.assert("only admins set flags, for known flags and scopes", async (ctx) => {
            const admin = await terminal(ctx, "admin-1");
            const listed = await admin.exec(
              "admin.feature-flags.list --scope org:acme --format json",
            );
            assert.equal(listed.exitCode, 0, listed.stderr);
            expect(JSON.parse(listed.stdout)).toContainEqual(
              expect.objectContaining({
                key: feature,
                value: false,
                overrides: [{ scope: "system", value: false }],
              }),
            );
            for (const command of [
              `admin.feature-flags.set --scope org:acme --key unknown --value off`,
              `admin.feature-flags.set --scope org:missing --key ${feature} --value off`,
              `admin.feature-flags.set --scope acme --key ${feature} --value off`,
            ]) {
              expect((await admin.exec(command)).exitCode).not.toBe(0);
            }
            const member = await terminal(ctx, "user-1");
            const unauthorized = await member.exec(
              `admin.feature-flags.set --scope system --key ${feature} --value off`,
            );
            expect(unauthorized.exitCode).not.toBe(0);
          }),
          then.assert("a system override applies wherever nothing overrides it", async (ctx) => {
            expect(await flag(ctx, "get", "org:other")).toMatchObject({ value: false });
            expect(await flag(ctx, "get", website)).toMatchObject({ value: false });
          }),
          then.assert("organization and project overrides take precedence", async (ctx) => {
            expect(await flag(ctx, "set --value on", "org:acme")).toMatchObject({
              value: true,
              overrides: [
                { scope: "org:acme", value: true },
                { scope: "system", value: false },
              ],
            });
            expect(await flag(ctx, "get", "org:other")).toMatchObject({ value: false });
            expect(await flag(ctx, "get", "app:org:acme:bookkeeping")).toMatchObject({
              value: true,
            });
            expect(await flag(ctx, "set --value off", website)).toMatchObject({
              value: false,
              overrides: [
                { scope: website, value: false },
                { scope: "org:acme", value: true },
                { scope: "system", value: false },
              ],
            });
            expect(await flag(ctx, "get", "org:acme")).toMatchObject({ value: true });
          }),
          runner.restartObject({ binding: "OVERRIDES", scope: acme }),
          runner.restartObject({ binding: "OVERRIDES", scope: { kind: "singleton" } }),
          then.assert("overrides survive restarts until cleared", async (ctx) => {
            const project = { kind: "project", owner: acme, projectId: "website" } as const;
            assert.isFalse(await isFeatureEnabledInScope(ctx.runtime.services, project, feature));
            assert.isTrue(await isFeatureEnabledInScope(ctx.runtime.services, acme, feature));

            expect(await flag(ctx, "clear", website)).toMatchObject({
              value: true,
              overrides: [
                { scope: "org:acme", value: true },
                { scope: "system", value: false },
              ],
            });
            await flag(ctx, "clear", "org:acme");
            await flag(ctx, "clear", "system");
            expect(await flag(ctx, "get", website)).toMatchObject({
              value: true,
              overrides: [],
            });
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entitlements accept only their own values, on their own scopes", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "entitlement overrides through the admin terminal",
      objects,
      setup: ({ given }) => [
        given.auth.user({ id: "admin-1", role: "admin" }),
        given.auth.user({ id: "user-1", role: "user" }),
        given.organization.exists({ id: acme.orgId, slug: "acme" }),
      ],
      steps: ({ then }) => [
        then.assert("organization management alone grants no entitlement", async (ctx) => {
          const delegate = await terminal(ctx, "admin-1", [
            BACKOFFICE_PERMISSION.admin.organizationsManage,
          ]);
          for (const command of [
            "admin.entitlements.set --scope user:user-1 --key email.recipients --value anyone",
            "admin.entitlements.set --scope system --key email.recipients --value anyone",
            `admin.feature-flags.set --scope org:acme --key ${feature} --value off`,
          ]) {
            const refused = await delegate.exec(command);
            expect(refused.exitCode).not.toBe(0);
            expect(refused.stderr).toContain("admin.users.manage");
          }
        }),
        then.assert("an admin grants one person what the definition allows", async (ctx) => {
          const admin = await terminal(ctx, "admin-1");
          const set = (scope: string, value: string) =>
            admin.exec(
              `admin.entitlements.set --scope ${scope} --key email.recipients --value ${value} --format json`,
            );
          const refused = await set("org:acme", "anyone");
          expect(refused.exitCode).not.toBe(0);
          expect(refused.stderr).toContain("only be overridden on system, user scopes");
          expect((await set("user:user-1", "everyone")).exitCode).not.toBe(0);

          const granted = await set("user:user-1", "anyone");
          assert.equal(granted.exitCode, 0, granted.stderr);
          expect(JSON.parse(granted.stdout)).toEqual({
            key: "email.recipients",
            description: expect.any(String),
            default: "own-and-verified-senders",
            value: "anyone",
            overrides: [{ scope: "user:user-1", value: "anyone" }],
          });
          const elsewhere = await admin.exec(
            "admin.entitlements.get --scope user:admin-1 --key email.recipients --format json",
          );
          assert.equal(elsewhere.exitCode, 0, elsewhere.stderr);
          expect(JSON.parse(elsewhere.stdout)).toMatchObject({
            value: "own-and-verified-senders",
            overrides: [],
          });
        }),
        then.assert(
          "a restriction it can no longer read fails rather than yielding",
          async (ctx) => {
            const admin = await terminal(ctx, "admin-1");
            const granted = await admin.exec(
              "admin.entitlements.set --scope system --key email.recipients --value anyone",
            );
            assert.equal(granted.exitCode, 0, granted.stderr);
            // As a value an entitlement stopped accepting would be stored; set refuses to write it.
            await ctx.runtime.objects.overrides.for(person).commands.setOverride({
              scope: person,
              kind: "entitlement",
              key: "email.recipients",
              value: "verified-senders-only",
            });
            await expect(
              entitlementInScope(ctx.runtime.services, person, "email.recipients"),
            ).rejects.toThrow('email.recipients on user:user-1 holds "verified-senders-only"');

            const cleared = await admin.exec(
              "admin.entitlements.clear --scope user:user-1 --key email.recipients",
            );
            assert.equal(cleared.exitCode, 0, cleared.stderr);
            assert(
              (await entitlementInScope(ctx.runtime.services, person, "email.recipients")) ===
                "anyone",
            );
          },
        ),
      ],
    }),
  );
});
