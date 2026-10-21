import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { usageBillingForScope } from "@/fragno/billing/usage-billing";
import { establishBackofficeAuthenticatedRequest } from "@/layouts/backoffice-authenticated-request.server";
import { sessionUserId } from "@/layouts/backoffice-layout.test-support";
import { establishBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { loader as agentsIndex } from "./agents/index";
import { loader } from "./organization-billing";

const origin = "https://backoffice.example";
const period = "2026-10";

async function openPage(
  ctx: BackofficeScenarioContext,
  cookie: string,
  path: string,
  orgSlug: string | null,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = new URL(path, origin);
    const request = new Request(url, { headers: { cookie } });
    const context = createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    });
    const args = { request, context, url, params: orgSlug === null ? {} : { orgSlug } };
    try {
      return await establishBackofficeAuthenticatedRequest(args, () =>
        establishBackofficeShellRequest(args, async () =>
          path === "/backoffice/agents"
            ? await agentsIndex(args as never)
            : Response.json(await loader(args as never)),
        ),
      );
    } catch (error) {
      assert(error instanceof Response);
      if (error.status !== 302) {
        return error;
      }
      assert.equal(error.headers.get("location"), url.pathname + url.search);
      cookie = [cookie, ...error.headers.getSetCookie().map((value) => value.split(";")[0])].join(
        "; ",
      );
    }
  }
  throw new Error("The usage page did not authenticate after refreshing its browser credential.");
}

test("personal usage survives organization changes and statements stay private", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-personal-usage-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "personal and organization usage statements",
        objects: allLocalObjects,
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({ ada: "", grace: "", adaId: "", graceId: "", orgId: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "ada" }),
          when.auth.signUp({ email: "grace@example.test", captureSessionCookieAs: "grace" }),
          then.assert(
            "a user without organizations can open agents and an empty statement",
            async (ctx) => {
              ctx.vars.adaId = await sessionUserId(ctx, ctx.vars.ada);
              ctx.vars.graceId = await sessionUserId(ctx, ctx.vars.grace);
              const agents = await openPage(ctx, ctx.vars.ada, "/backoffice/agents", null);
              assert.equal(agents.status, 302);
              assert.equal(
                agents.headers.get("location"),
                `/backoffice/agents/user/${ctx.vars.adaId}/agents`,
              );
              const response = await openPage(
                ctx,
                ctx.vars.ada,
                `/backoffice/usage?period=${period}`,
                null,
              );
              assert.equal(response.status, 200);
              expect(await response.json()).toEqual({
                period,
                ownerName: "Personal",
                trackers: [],
              });
            },
          ),
          then.assert(
            "nested personal work records once in its root owner's ledger",
            async (ctx) => {
              const scope = {
                kind: "project",
                owner: {
                  kind: "app",
                  owner: { kind: "user", userId: ctx.vars.adaId },
                  appId: "books",
                },
                projectId: "personal-books",
              } as const;
              const billing = usageBillingForScope(ctx.runtime.services, scope);
              assert(billing.kind === "customer");
              const event = {
                id: "personal-work",
                scope,
                source: "scenario",
                eventType: "work.completed",
                occurredAt: "2026-10-20T12:00:00.000Z",
                measurements: [{ meter: "codemode.executions", unit: "execution", quantity: 2 }],
              };
              await billing.recordEvent(event, { propagationContext: null });
              await billing.recordEvent(event, { propagationContext: null });
            },
          ),
          when.auth.createOrganization({
            cookie: ({ vars }) => vars.ada,
            name: "Ada's books",
            slug: "ada-books",
            captureOrganizationIdAs: "orgId",
          }),
          then.assert(
            "organization-owned work stays separate even for the same person",
            async (ctx) => {
              const scope = {
                kind: "project",
                owner: { kind: "org", orgId: ctx.vars.orgId },
                projectId: "company-books",
              } as const;
              const billing = usageBillingForScope(ctx.runtime.services, scope);
              assert(billing.kind === "customer");
              await billing.recordEvent(
                {
                  id: "company-work",
                  scope,
                  source: "scenario",
                  eventType: "work.completed",
                  occurredAt: "2026-10-20T12:00:00.000Z",
                  measurements: [{ meter: "codemode.executions", unit: "execution", quantity: 7 }],
                },
                { propagationContext: null },
              );
            },
          ),
          then.assert("reopen the personal ledger", async (ctx) => {
            await ctx.runtime.restartObject({
              binding: "BILLING",
              scope: { kind: "user", userId: ctx.vars.adaId },
            });
          }),
          then.assert(
            "statements use authenticated identity, not caller-selected users",
            async (ctx) => {
              const personal = await openPage(
                ctx,
                ctx.vars.ada,
                `/backoffice/usage?period=${period}`,
                null,
              );
              expect(await personal.json()).toMatchObject({
                trackers: [{ meter: "codemode.executions", quantity: "2", eventCount: "1" }],
              });
              const stranger = await openPage(
                ctx,
                ctx.vars.grace,
                `/backoffice/usage?period=${period}&userId=${ctx.vars.adaId}`,
                null,
              );
              expect(await stranger.json()).toMatchObject({ trackers: [] });
              const company = await openPage(
                ctx,
                ctx.vars.ada,
                `/backoffice/organizations/ada-books/billing?period=${period}`,
                "ada-books",
              );
              expect(await company.json()).toMatchObject({
                trackers: [{ meter: "codemode.executions", quantity: "7", eventCount: "1" }],
              });
              const forbidden = await openPage(
                ctx,
                ctx.vars.grace,
                `/backoffice/organizations/ada-books/billing?period=${period}`,
                "ada-books",
              );
              assert.equal(forbidden.status, 404);
              const invalid = await openPage(
                ctx,
                ctx.vars.ada,
                "/backoffice/usage?period=invalid",
                null,
              );
              assert.equal(invalid.status, 400);
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
