import { assert, expect, test } from "vitest";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { loader as organizationLayoutLoader } from "@/routes/backoffice/organization-layout";
import { loader as overviewLoader } from "@/routes/backoffice/organization-overview";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { loader as layoutLoader } from "./backoffice-layout";
import {
  behindBackofficeLayout,
  createAutomationProject,
  sessionUserId,
  withBackofficeAccessToken,
} from "./backoffice-layout.test-support";

const origin = "https://backoffice.example";

type Vars = {
  cookie: string;
  userId: string;
  orgId: string;
  website: { id: string; slug: string };
};
type Ctx = BackofficeScenarioContext<Vars>;

/** Runs a loader behind the Backoffice layout middleware for a page at `path`. */
async function load<TData>(
  ctx: Ctx,
  loader: (args: never) => Promise<TData>,
  path: string,
  params: Record<string, string>,
): Promise<TData> {
  const url = new URL(path, origin);
  const request = new Request(url, { headers: { cookie: ctx.vars.cookie, origin } });
  return await behindBackofficeLayout(loader)({
    request,
    url,
    pattern: url.pathname,
    params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  } as never);
}

/** The probe the top bar shows on a page whose URL names the scope as `<kind>/<id>`. */
async function probeOn(ctx: Ctx, scopeKind: string, scopeId: string) {
  const data = await load(ctx, layoutLoader, `/backoffice/dashboard/${scopeKind}/${scopeId}`, {
    scopeKind,
    scopeId,
  });
  return await data.scopeProbe;
}

const acmeSettings = ["/backoffice/organizations/acme", { orgSlug: "acme" }] as const;

async function setFlag(ctx: Ctx, scope: string, key: string, value: "on" | "off") {
  const { bash } = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution: createBackofficeSystemExecution({ kind: "system" }),
    }),
  });
  const result = await bash.exec(
    `admin.feature-flags.set --scope ${scope} --key ${key} --value ${value}`,
  );
  assert.equal(result.exitCode, 0, result.stderr);
}

test("the scope probe names the scope whose override turned it on for each page, and only the overview waits for its flag", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      name: "Backoffice scope probe",
      objects: allLocalObjects,
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      vars: () => ({ cookie: "", userId: "", orgId: "", website: { id: "", slug: "" } }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@acme.test", captureSessionCookieAs: "cookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.cookie,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert("the probe is off until an override turns it on", async (ctx) => {
          ctx.vars.userId = await sessionUserId(ctx, ctx.vars.cookie);
          ctx.vars.cookie = await withBackofficeAccessToken(ctx, ctx.vars.cookie, ctx.vars.orgId);
          ctx.vars.website = await createAutomationProject(ctx, {
            orgId: ctx.vars.orgId,
            name: "Website",
            createdByUserId: ctx.vars.userId,
          });
          expect(await probeOn(ctx, "org", "acme")).toEqual({ kind: "off" });
        }),
        then.assert("each page names the most specific override on its chain", async (ctx) => {
          const project = `project:org:acme:${ctx.vars.website.id}`;
          const projectPage = ["project", `org:acme:${ctx.vars.website.slug}`] as const;

          await setFlag(ctx, "system", "scope-probe", "on");
          expect(await probeOn(ctx, "user", ctx.vars.userId)).toEqual({
            kind: "on",
            decidedBy: "system",
          });

          await setFlag(ctx, "org:acme", "scope-probe", "on");
          await setFlag(ctx, project, "scope-probe", "off");
          expect(await probeOn(ctx, "org", "acme")).toEqual({
            kind: "on",
            decidedBy: "org:acme",
          });
          expect(await probeOn(ctx, ...projectPage)).toEqual({ kind: "off" });

          await setFlag(ctx, project, "scope-probe", "on");
          expect(await probeOn(ctx, ...projectPage)).toEqual({ kind: "on", decidedBy: project });
          expect(await probeOn(ctx, "user", ctx.vars.userId)).toEqual({
            kind: "on",
            decidedBy: "system",
          });
        }),
        then.assert("the overview shows the access summary as its flag says", async (ctx) => {
          expect(await load(ctx, overviewLoader, ...acmeSettings)).toEqual({
            showsAccessSummary: true,
          });
          await setFlag(ctx, "org:acme", "organization-access-summary", "off");
          expect(await load(ctx, overviewLoader, ...acmeSettings)).toEqual({
            showsAccessSummary: false,
          });
        }),
        then.assert("an unreadable flag fails only the overview that reads it", async (ctx) => {
          const acme = { kind: "org", orgId: ctx.vars.orgId, jurisdiction: null } as const;
          // As a value a flag no longer accepts would be stored; set refuses to write it.
          await ctx.runtime.objects.overrides.for(acme).commands.setOverride({
            scope: acme,
            kind: "feature-flag",
            key: "organization-access-summary",
            value: "maybe",
          });
          await expect(load(ctx, overviewLoader, ...acmeSettings)).rejects.toThrow(
            "organization-access-summary",
          );
          expect(await load(ctx, organizationLayoutLoader, ...acmeSettings)).toMatchObject({
            organization: { slug: "acme" },
          });
          expect(await probeOn(ctx, "org", "acme")).toEqual({ kind: "on", decidedBy: "org:acme" });
        }),
      ],
    }),
  );
});
