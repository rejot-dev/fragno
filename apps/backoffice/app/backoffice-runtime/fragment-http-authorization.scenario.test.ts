import { assert, describe, expect, test, vi } from "vitest";

import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadOrganizationMembers,
  loadOrganizationInvitations,
  loadUserInvitations,
  loadSystemUsers,
} from "@/fragno/auth/auth-directory.server";
import { requireBackofficeMe } from "@/fragno/auth/auth-server";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { verifyBackofficeJwt } from "@/fragno/auth/token-lifecycle";
import {
  CODEMODE_WORKFLOW,
  codemodeWorkflowParamsSchema,
} from "@/fragno/automation/engine/codemode-invocation";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { forwardPublicFragmentRequest } from "@/fragno/public-fragment-route.server";
import { createApiRuntime } from "@/fragno/runtime-tools/families/api-runtime";
import { createFormsRuntime } from "@/fragno/runtime-tools/families/forms-runtime";
import { apiPublicRoute } from "@/routes/api/api-route.server";
import { mcpPublicRoute } from "@/routes/api/mcp-route.server";
import { loader as loadInvitationPreview } from "@/routes/backoffice/invitation-accept";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { authorizedBackofficeObjectHttp } from "./authorized-object-http";
import { createBackofficeSystemExecution, createBackofficeUserExecution } from "./context";
import { deferBackofficeExecution } from "./context";
import { BackofficeKernel } from "./kernel";
import { backofficeObjectScopeFromContextScope } from "./object-registry";

const origin = "https://backoffice.example";

function routerContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

async function exchangeBrowserSession(ctx: BackofficeScenarioContext) {
  const cookie = ctx.vars.session;
  assert(typeof cookie === "string");
  const response = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/backoffice-token`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ selection: "preferred", organizationId: null }),
    }),
  );
  assert(response.ok, await response.clone().text());
  const accessCookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const request = new Request(`${origin}/api/backoffice/me`, { headers: { cookie: accessCookie } });
  const me = await requireBackofficeMe(request, routerContext(ctx, request));
  return { accessCookie, me };
}

async function runHttpAuthorityScenario(check: (ctx: BackofficeScenarioContext) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-http-authority-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "fragment HTTP authority",
        options: { sqliteDataDirectory: directory },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        steps: ({ when, then }) => [
          when.auth.signUp({
            email: "http-authority@example.test",
            captureSessionCookieAs: "session",
          }),
          then.assert("real HTTP routes enforce operation authority", async (ctx) => {
            try {
              await check(ctx);
            } catch (error) {
              if (error instanceof Response) {
                throw new Error(`Unexpected HTTP ${error.status}: ${await error.text()}`);
              }
              throw error;
            }
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("fragment HTTP authority scenarios", () => {
  test("Forms separates public submissions from management and denies unlisted routes", async () => {
    await runHttpAuthorityScenario(async (ctx) => {
      const { accessCookie, me } = await exchangeBrowserSession(ctx);
      const scope = { kind: "org" as const, orgId: me.organizations[0].organization.id };
      const request = new Request(origin, { headers: { cookie: accessCookie } });
      const execution = await requireBackofficeContext(request, routerContext(ctx, request), scope);
      const forms = ctx.runtime.objects.forms.singleton();
      const adminUrl = `${origin}/api/forms/admin/forms`;
      const anonymous = await forms.http.fetch(new Request(adminUrl));
      assert(anonymous.status === 401);
      const denied = await forms.http.fetchAuthorized(new Request(adminUrl), {
        execution: { ...execution, scope: { kind: "system" } },
      });
      assert(denied.status === 403);
      const runtime = createFormsRuntime(
        authorizedBackofficeObjectHttp(
          forms.http,
          createBackofficeSystemExecution({ kind: "system" }),
        ),
      );
      const { id } = await runtime.createForm({
        title: "Public intake",
        description: null,
        slug: "public-intake",
        status: "open",
        dataSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      });
      const published = await forms.http.fetch(new Request(`${origin}/api/forms/public-intake`));
      assert(published.ok, await published.clone().text());
      const submitted = await forms.http.fetch(
        new Request(`${origin}/api/forms/public-intake/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: { message: "hello" } }),
        }),
      );
      assert(submitted.ok, await submitted.clone().text());
      const submissions = await runtime.listSubmissions({
        formId: id,
        sortOrder: "asc",
        pageSize: 10,
        cursor: null,
      });
      expect(submissions).toMatchObject({ submissions: [{ data: { message: "hello" } }] });
      const hidden = await forms.http.fetch(new Request(`${origin}/api/forms/_internal`));
      // /:slug is public; a missing public form is a fragment-owned 404, not management access.
      assert(hidden.status === 404);
      const internal = await forms.http.fetch(new Request(`${origin}/api/forms/_internal/schema`));
      assert(internal.status === 404);
      expect(await internal.json()).toMatchObject({ code: "ROUTE_NOT_FOUND" });

      const reson8 = ctx.runtime.objects.reson8.forOrg(scope.orgId);
      await reson8.commands.setAdminConfig({ apiKey: "test-key" }, scope.orgId);
      const url = `${origin}/api/reson8/custom-model`;
      assert((await reson8.http.fetch(new Request(url))).status === 401);
      const forbidden = await reson8.http.fetchAuthorized(new Request(url), { execution });
      assert(forbidden.status === 403);
      const unexposed = await reson8.http.fetchAuthorized(
        new Request(`${origin}/api/reson8/_internal`),
        { execution },
      );
      assert(unexposed.status === 404);
    });
  });

  test("auth directory loaders use real sessions and keep invitation preview read-only", async () => {
    await runHttpAuthorityScenario(async (ctx) => {
      const { accessCookie, me } = await exchangeBrowserSession(ctx);
      const organization = me.organizations[0].organization;
      const session = ctx.vars.session;
      assert(typeof session === "string");
      const request = new Request(
        `${origin}/backoffice/organizations/${organization.slug}/members`,
        { headers: { cookie: `${session}; ${accessCookie}` } },
      );
      const input = { request, context: routerContext(ctx, request) };
      const auth = ctx.runtime.objects.auth.singleton();
      await auth.commands.applyScenarioFixture({
        users: [{ id: me.user.id, email: me.user.email, role: "user", status: "active" }],
      });
      expect((await loadOrganizationMembers(input, organization.slug)).members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: me.user.id,
            user: expect.objectContaining({ email: me.user.email }),
          }),
        ]),
      );
      expect((await loadOrganizationInvitations(input, organization.slug)).invitations).toEqual([]);
      expect((await loadUserInvitations(input)).invitations).toEqual([]);
      await expect(loadSystemUsers(input)).rejects.toMatchObject({ status: 403 });
      const invitationResponse = await auth.http.fetch(
        new Request(`${origin}/api/auth/organization/invite-member`, {
          method: "POST",
          headers: { cookie: session, origin, "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: organization.id,
            email: "invited@example.test",
            role: "member",
          }),
        }),
      );
      assert(invitationResponse.ok, await invitationResponse.clone().text());
      const invitation = z.object({ id: z.string() }).parse(await invitationResponse.json());
      const signup = await auth.http.fetch(
        new Request(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Invited",
            email: "invited@example.test",
            password: "secure-password-123",
          }),
        }),
      );
      assert(signup.ok, await signup.clone().text());
      const invitedUser = z
        .object({ user: z.object({ id: z.string() }) })
        .parse(await signup.json()).user;
      await auth.commands.applyScenarioFixture({
        users: [
          { id: invitedUser.id, email: "invited@example.test", role: "user", status: "active" },
        ],
      });
      const invitedCookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const previewRequest = new Request(`${origin}/backoffice/invitations/${invitation.id}`, {
        headers: { cookie: invitedCookie },
      });
      const preview = await loadInvitationPreview({
        request: previewRequest,
        context: routerContext(ctx, previewRequest),
        params: { invitationId: invitation.id },
      } as never);
      expect(preview.organization).toEqual({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      });
      const listed = await loadUserInvitations({
        request: previewRequest,
        context: routerContext(ctx, previewRequest),
      });
      expect(listed.invitations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invitation: expect.objectContaining({ id: invitation.id, status: "pending" }),
          }),
        ]),
      );
      assert((await loadOrganizationMembers(input, organization.slug)).total === 1);
    });
  });
  test("public HTTP, bound runtime calls, and direct object requests cannot bypass operation permissions", async () => {
    await runHttpAuthorityScenario(async (ctx) => {
      const { accessCookie, me } = await exchangeBrowserSession(ctx);
      const organization = me.organizations[0].organization;
      const scope = { kind: "org" as const, orgId: organization.id };
      const scopeSegment = `org:${organization.slug}`;
      const api = ctx.runtime.objects.api.for(scope);
      const connection = {
        name: "Protected connection",
        baseUrl: "https://provider.example",
        auth: { type: "none" as const },
      };
      function connectionRequest(cookie: string) {
        return new Request(
          `${origin}/api/http/${encodeURIComponent(scopeSegment)}/connections/protected`,
          {
            method: "PUT",
            headers: { cookie, origin, "content-type": "application/json" },
            body: JSON.stringify(connection),
          },
        );
      }
      const request = connectionRequest(accessCookie);
      const context = routerContext(ctx, request);
      const execution = await requireBackofficeContext(request, context, scope);
      const denied = await forwardPublicFragmentRequest({
        request,
        context,
        scopePathSegment: scopeSegment,
        route: apiPublicRoute,
      });
      assert(denied.status === 403);
      const obsoleteBypass = { execution, authorization: "preauthorized" as const };
      const bypassed = await api.http.fetchAuthorized(
        new Request(`${origin}/api/api/connections/forged`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(connection),
        }),
        obsoleteBypass,
      );
      assert(bypassed.status === 403);
      const apiRuntime = createApiRuntime(
        authorizedBackofficeObjectHttp(api.http, execution),
        async () => ({
          baseUrl: `${origin}/api/http/${encodeURIComponent(scopeSegment)}`,
          oauthRedirectUri: `${origin}/api/http/${encodeURIComponent(scopeSegment)}/oauth/callback`,
        }),
      );
      await expect(
        apiRuntime.createConnection({ slug: "protected", ...connection }),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      expect(await apiRuntime.listConnections()).toEqual({ connections: [] });
      assert((await api.http.fetch(new Request(`${origin}/api/api/connections`))).status === 401);
      const callback = await api.http.fetch(new Request(`${origin}/api/api/oauth/callback`));
      assert(callback.status === 400);
      expect(await callback.json()).toMatchObject({ code: "INVALID_OAUTH_STATE" });
      for (const { http, prefix } of [
        { http: api.http, prefix: "/api/api" },
        { http: ctx.runtime.objects.mcp.for(scope).http, prefix: "/api/mcp" },
      ]) {
        const unlisted = await http.fetchAuthorized(new Request(`${origin}${prefix}/_internal`), {
          execution: createBackofficeSystemExecution(scope),
        });
        assert(unlisted.status === 404);
        expect(await unlisted.json()).toMatchObject({ code: "FRAGMENT_ROUTE_NOT_EXPOSED" });
      }
      const mcpRequest = new Request(
        `${origin}/api/mcp/${encodeURIComponent(scopeSegment)}/servers`,
        { headers: { cookie: accessCookie } },
      );
      const mcpDenied = await forwardPublicFragmentRequest({
        request: mcpRequest,
        context: routerContext(ctx, mcpRequest),
        scopePathSegment: scopeSegment,
        route: mcpPublicRoute,
      });
      assert(mcpDenied.status === 403);
      assert(
        (
          await ctx.runtime.objects.mcp
            .for(scope)
            .http.fetch(new Request(`${origin}/api/mcp/servers`))
        ).status === 401,
      );

      await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
        users: [{ id: me.user.id, email: me.user.email, role: "admin", status: "active" }],
      });
      const admin = await exchangeBrowserSession(ctx);
      const allowedRequest = connectionRequest(admin.accessCookie);
      const allowed = await forwardPublicFragmentRequest({
        request: allowedRequest,
        context: routerContext(ctx, allowedRequest),
        scopePathSegment: scopeSegment,
        route: apiPublicRoute,
      });
      assert(allowed.ok, await allowed.clone().text());
      for (const spelling of [scopeSegment, encodeURIComponent(scopeSegment)]) {
        for (const { route, pathname } of [
          { route: apiPublicRoute, pathname: "/connections" },
          { route: mcpPublicRoute, pathname: "/servers" },
        ]) {
          const managementRequest = new Request(
            `${origin}${route.publicPrefix}/${spelling}${pathname}`,
            {
              headers: { cookie: admin.accessCookie },
            },
          );
          const management = await forwardPublicFragmentRequest({
            request: managementRequest,
            context: routerContext(ctx, managementRequest),
            scopePathSegment: scopeSegment,
            route,
          });
          assert.equal(management.status, 200, await management.clone().text());
        }
      }
      expect((await apiRuntime.listConnections()).connections).toMatchObject([
        { slug: "protected" },
      ]);
      // Promoting the user does not silently upgrade an already issued request snapshot.
      await expect(
        apiRuntime.createConnection({ slug: "another", ...connection }),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      const internal = await api.http.fetchAuthorized(
        new Request(`${origin}/api/api/connections`),
        { execution: createBackofficeSystemExecution(scope) },
      );
      assert(internal.ok);
      expect(
        z.object({ connections: z.array(z.unknown()) }).parse(await internal.json()).connections,
      ).toHaveLength(1);

      const deferred = createApiRuntime(
        authorizedBackofficeObjectHttp(
          api.http,
          createBackofficeUserExecution({ scope, userId: me.user.id }),
        ),
        async () => ({ baseUrl: origin, oauthRedirectUri: `${origin}/callback` }),
      );
      await deferred.createConnection({ slug: "before-revocation", ...connection });
      await ctx.runtime.objects.auth.singleton().commands.applyScenarioFixture({
        users: [{ id: me.user.id, email: me.user.email, role: "user", status: "active" }],
      });
      await expect(
        deferred.createConnection({ slug: "after-revocation", ...connection }),
      ).rejects.toMatchObject({ reason: "principal-permission-denied" });
      // A previously issued browser snapshot is deliberately not a live-role lookup.
      const originalSnapshotRequest = connectionRequest(admin.accessCookie);
      const snapshotRequest = new Request(
        originalSnapshotRequest.url.replace("/protected", "/snapshot-authority"),
        originalSnapshotRequest,
      );
      assert(
        (
          await forwardPublicFragmentRequest({
            request: snapshotRequest,
            context: routerContext(ctx, snapshotRequest),
            scopePathSegment: scopeSegment,
            route: apiPublicRoute,
          })
        ).status === 201,
      );
      expect(
        (await apiRuntime.listConnections()).connections.map(({ slug }) => slug).sort(),
      ).toEqual(["before-revocation", "protected", "snapshot-authority"]);
    });
  });

  test("a real CLI exchange signs a project restriction and cannot authorize sibling, organization, or personal scopes", async () => {
    await runHttpAuthorityScenario(async (ctx) => {
      const { me } = await exchangeBrowserSession(ctx);
      const auth = ctx.runtime.objects.auth.singleton();
      const sessionCookie = ctx.vars.session;
      assert(typeof sessionCookie === "string");
      const config = await auth.commands.getBackofficeCliOAuthConfig({ requestUrl: origin });
      async function authPost(pathname: string, body: URLSearchParams | { userCode: string }) {
        const response = await auth.http.fetch(
          new Request(`${origin}/api/auth${pathname}`, {
            method: "POST",
            headers: {
              cookie: sessionCookie as string,
              origin,
              "content-type":
                body instanceof URLSearchParams
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            },
            body: body instanceof URLSearchParams ? body : JSON.stringify(body),
          }),
        );
        assert(response.ok, await response.clone().text());
        return await response.json();
      }
      const device = z.object({ user_code: z.string(), device_code: z.string() }).parse(
        await authPost(
          "/device/code",
          new URLSearchParams({
            client_id: config.clientId,
            scope: config.scope,
            resource: origin,
          }),
        ),
      );
      const claimed = await auth.http.fetch(
        new Request(`${origin}/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`, {
          headers: { cookie: sessionCookie, origin },
        }),
      );
      assert(claimed.ok, await claimed.clone().text());
      await authPost("/device/approve", { userCode: device.user_code });
      const oauth = z.object({ access_token: z.string() }).parse(
        await authPost(
          "/oauth2/token",
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code,
            client_id: config.clientId,
            resource: origin,
          }),
        ),
      );
      const scope = {
        kind: "project" as const,
        orgId: me.organizations[0].organization.id,
        projectId: "project-one",
      };
      const token = await auth.commands.exchangeBackofficeExecutionToken({
        requestUrl: origin,
        oauthAccessToken: oauth.access_token,
        scope,
      });
      const verified = await verifyBackofficeJwt(token.accessToken, origin, auth.http);
      assert(verified.ok);
      expect(verified.payload.scopeRestriction).toEqual(scope);
      const request = new Request(`${origin}/api/http`, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      const context = routerContext(ctx, request);
      const execution = await requireBackofficeContext(request, context, scope);
      const response = await ctx.runtime.objects.api
        .for(scope)
        .http.fetchAuthorized(new Request(`${origin}/api/api/connections`), { execution });
      assert(response.ok, await response.clone().text());
      for (const target of [
        { ...scope, projectId: "project-two" },
        { kind: "org" as const, orgId: scope.orgId },
        { kind: "user" as const, userId: me.user.id },
      ]) {
        await expect(requireBackofficeContext(request, context, target)).rejects.toThrow(
          "Credential scope",
        );
        const denied = await ctx.runtime.objects.api
          .for(target)
          .http.fetchAuthorized(new Request(`${origin}/api/api/connections`), {
            execution: { ...execution, scope: target },
          });
        assert(denied.status === 403);
      }

      const jobId = "cli-scope-ceiling";
      const jobUrl = `${origin}/api/workflows/${CODEMODE_WORKFLOW}/instances`;
      const scheduled = await ctx.runtime.objects.automations.for(scope).http.fetchAuthorized(
        new Request(jobUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: jobId,
            remoteWorkflowName: "cli-scope-ceiling",
            params: {
              program: {
                code: 'defineWorkflow({ name: "cli-scope-ceiling" }, async (event, step) => { await step.sleep("wait", "1 hour"); });',
                dependencies: {},
                workflowName: "cli-scope-ceiling",
                filename: "/workspace/automations/cli-scope-ceiling.workflow.js",
              },
              trigger: { type: "manual", payload: {} },
              // A caller cannot erase its credential ceiling in persisted workflow parameters.
              execution: {
                scope,
                scopeRestriction: null,
                actors: execution.actors,
                billingOrganizationId: scope.orgId,
                capabilityGrants: [],
              },
            },
          }),
        }),
        { execution },
      );
      assert(scheduled.ok, await scheduled.clone().text());
      await ctx.runtime.restartObject({
        binding: "AUTOMATIONS",
        scope: backofficeObjectScopeFromContextScope(scope),
      });
      ctx.runtime.advanceTime(16 * 60 * 1000);
      const deferred = deferBackofficeExecution(execution);
      const restored = await ctx.runtime.objects.automations
        .for(scope)
        .http.fetchAuthorized(new Request(`${jobUrl}/${jobId}`), { execution: deferred });
      assert(restored.ok, await restored.clone().text());
      const stored = z
        .object({ meta: z.object({ params: codemodeWorkflowParamsSchema }) })
        .parse(await restored.json());
      expect(stored.meta.params.execution.scopeRestriction).toEqual(scope);
      expect(stored.meta.params.execution).not.toHaveProperty("userAuthority");
      const resumed = deferBackofficeExecution({
        kind: "deferred",
        ...stored.meta.params.execution,
      });
      const sameProject = await ctx.runtime.objects.api
        .for(scope)
        .http.fetchAuthorized(new Request(`${origin}/api/api/connections`), { execution: resumed });
      assert(sameProject.ok, await sameProject.clone().text());
      for (const target of [
        { ...scope, projectId: "project-two" },
        { kind: "org" as const, orgId: scope.orgId },
        { kind: "user" as const, userId: me.user.id },
      ]) {
        const denied = await ctx.runtime.objects.api
          .for(target)
          .http.fetchAuthorized(new Request(`${origin}/api/api/connections`), {
            execution: { ...resumed, scope: target },
          });
        assert(denied.status === 403, await denied.clone().text());
      }
      await auth.commands.applyScenarioFixture({
        users: [{ id: me.user.id, email: me.user.email, role: "user", status: "banned" }],
      });
      const revoked = await ctx.runtime.objects.api
        .for(scope)
        .http.fetchAuthorized(new Request(`${origin}/api/api/connections`), { execution: resumed });
      assert(revoked.status === 403, await revoked.clone().text());
    });
  });
});
