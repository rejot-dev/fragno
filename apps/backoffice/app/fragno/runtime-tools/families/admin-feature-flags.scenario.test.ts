import { assert, expect, test } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { featureFlagStatusSchema } from "@/fragno/feature-flags/contracts";
import { isOrganizationFeatureEnabled } from "@/fragno/feature-flags/evaluate.server";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FeatureFlagsObject } from "../../../../workers/feature-flags-object";

const objects = {
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  FEATURE_FLAGS: (input) => new FeatureFlagsObject(input),
} satisfies LocalBackofficeObjects;

const feature = "organization-access-summary";
const acme = { kind: "org", orgId: "org-1", jurisdiction: null } as const;

async function terminal(ctx: BackofficeScenarioContext, userId: string) {
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    execution: createBackofficeUserExecution({ scope: { kind: "system" }, userId }),
  });
  assert(context.stateBackend);
  return (
    await createInteractiveBashHost({ context: { ...context, stateBackend: context.stateBackend } })
  ).bash;
}

async function flagCommand(ctx: BackofficeScenarioContext, command: "get" | "set", args: string) {
  const bash = await terminal(ctx, "admin-1");
  const result = await bash.exec(
    `admin.feature-flags.${command} --key ${feature} ${args} --format json`,
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return featureFlagStatusSchema.parse(JSON.parse(result.stdout));
}

test("admin feature flags persist by organization and apply to its projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "backoffice-feature-flags-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "organization feature flag lifecycle through the admin terminal",
        objects,
        options: { sqliteDataDirectory: directory },
        setup: ({ given }) => [
          given.auth.user({ id: "admin-1", role: "admin" }),
          given.organization.exists({ id: acme.orgId, slug: "acme" }),
          given.organization.exists({ id: "org-2", slug: "other" }),
        ],
        steps: ({ then, runner }) => [
          then.assert(
            "an admin can discover the default and disable a feature for one organization",
            async (ctx) => {
              const bash = await terminal(ctx, "admin-1");
              const listed = await bash.exec("admin.feature-flags.list --org acme --format json");
              assert.equal(listed.exitCode, 0, listed.stderr);
              expect(JSON.parse(listed.stdout)).toContainEqual(
                expect.objectContaining({
                  key: feature,
                  defaultEnabled: true,
                  override: null,
                  enabled: true,
                }),
              );
              const unknown = await bash.exec(
                "admin.feature-flags.set --org acme --key unknown --value off",
              );
              expect(unknown.exitCode).not.toBe(0);

              const member = await terminal(ctx, "user-1");
              const unauthorized = await member.exec(
                `admin.feature-flags.set --org acme --key ${feature} --value off`,
              );
              expect(unauthorized.exitCode).not.toBe(0);
              expect(await flagCommand(ctx, "get", "--org acme")).toMatchObject({
                override: null,
                enabled: true,
              });

              expect(await flagCommand(ctx, "set", "--org acme --value off")).toMatchObject({
                override: false,
                enabled: false,
              });
              expect(await flagCommand(ctx, "get", "--org other")).toMatchObject({
                override: null,
                enabled: true,
              });
            },
          ),
          runner.restartObject({ binding: "FEATURE_FLAGS", scope: acme }),
          then.assert(
            "the override survives a restart and serves organization-owned projects",
            async (ctx) => {
              expect(await flagCommand(ctx, "get", "--org acme")).toMatchObject({
                override: false,
                enabled: false,
              });
              const bash = await terminal(ctx, "admin-1");
              const listed = await bash.exec("admin.feature-flags.list --org acme --format json");
              assert.equal(listed.exitCode, 0, listed.stderr);
              expect(JSON.parse(listed.stdout)).toContainEqual(
                expect.objectContaining({ key: feature, override: false, enabled: false }),
              );
              expect(await flagCommand(ctx, "set", "--org acme --value off")).toMatchObject({
                override: false,
                enabled: false,
              });
              const project = { kind: "project", owner: acme, projectId: "project-1" } as const;
              assert.isFalse(
                await isOrganizationFeatureEnabled(ctx.runtime.services, project, feature),
              );

              expect(await flagCommand(ctx, "set", "--org acme --value on")).toMatchObject({
                override: true,
                enabled: true,
              });
              expect(await flagCommand(ctx, "set", "--org acme --value default")).toMatchObject({
                override: null,
                enabled: true,
              });
              expect(await flagCommand(ctx, "get", "--org acme")).toMatchObject({
                override: null,
                enabled: true,
              });
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
