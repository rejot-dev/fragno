import { assert } from "vitest";

import { mapBackofficeScopeNames } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  backofficeOrganizationIdentity,
  backofficeProjectIdentity,
  type BackofficeNamedProject,
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import type {
  BackofficeAuthPrincipal,
  BackofficeMeData,
  Organization,
} from "@/fragno/auth/contracts";
import type { BackofficeScenarioContext } from "@/fragno/automation/scenario";

import { establishBackofficeAuthenticatedRequest } from "./backoffice-authenticated-request.server";
import {
  BackofficeShellRequestContext,
  establishBackofficeShellRequest,
} from "./backoffice-shell-request.server";

type BackofficeRouteHandlerArgs = {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: Readonly<Record<string, string | undefined>>;
};

/**
 * Wraps a protected Backoffice loader or action so it runs behind the Backoffice layout
 * middleware, as React Router runs it. Responses thrown by the middleware propagate unchanged.
 */
export function behindBackofficeLayout<TArgs extends BackofficeRouteHandlerArgs, TResult>(
  handler: (args: TArgs) => Promise<TResult> | TResult,
): (args: TArgs) => Promise<TResult> {
  return async (args) => {
    let handled: { result: TResult } | null = null;
    // Tests call handlers with page URLs, never React Router's `.data` endpoints.
    const middlewareArgs = { ...args, url: new URL(args.request.url) };
    await establishBackofficeAuthenticatedRequest(middlewareArgs, () =>
      establishBackofficeShellRequest(middlewareArgs, async () => {
        handled = { result: await handler(args) };
        return new Response(null);
      }),
    );
    if (!handled) {
      throw new Error("The Backoffice layout middleware did not run the route handler.");
    }
    return (handled as { result: TResult }).result;
  };
}

/**
 * Provides the shell request the Backoffice layout middleware establishes, for unit tests that
 * call a protected handler directly. `routeScope` is null when the URL's scope does not resolve.
 */
export function provideBackofficeShellRequest(
  context: RouterContextProvider,
  input: {
    me: BackofficeMeData;
    routeScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> | null;
  },
): void {
  const { me, routeScope } = input;
  const defaultScope: BackofficeResolvedScope<Organization, BackofficeNamedProject> = {
    kind: "user",
    userId: me.user.id,
  };
  const accessTokenExpiresAt = new Date(Date.now() + 60_000);
  context.set(BackofficeShellRequestContext, {
    me,
    principal: {
      user: me.user,
      auth: { scopeRestriction: null, transport: "cookie", expiresAt: accessTokenExpiresAt },
    } as unknown as BackofficeAuthPrincipal,
    resolvedScope: routeScope ?? defaultScope,
    administeredMember: null,
    route: routeScope
      ? {
          status: "resolved",
          resolvedScope: routeScope,
          execution: {
            scope: backofficeRuntimeScopeFromResolvedScope(routeScope),
          } as BackofficeExecutionContext,
          selection: selectionOf(routeScope, me),
        }
      : { status: "not-found" },
    accessTokenExpiresAt,
  });
}

function selectionOf(
  scope: BackofficeResolvedScope<Organization, BackofficeNamedProject>,
  me: BackofficeMeData,
): BackofficeScopeSelection {
  return {
    ...mapBackofficeScopeNames(scope, {
      organization: ({ organization }) => ({
        organization: backofficeOrganizationIdentity(organization),
      }),
      project: ({ project }) => ({ project: backofficeProjectIdentity(project) }),
    }),
    label: labelOf(scope, me),
  };
}

function labelOf(
  scope: BackofficeResolvedScope<Organization, BackofficeNamedProject>,
  me: BackofficeMeData,
): string {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org":
      return scope.organization.name ?? scope.organization.id;
    case "user":
      return me.user.email ?? me.user.id;
    case "app":
      return scope.appId;
    case "project":
      return scope.project.name;
    default:
      throw new Error("Backoffice scope kind is unsupported.", { cause: scope satisfies never });
  }
}

const scenarioOrigin = "https://backoffice.example";

async function authRequest(
  ctx: BackofficeScenarioContext,
  cookie: string,
  pathname: string,
  body?: unknown,
) {
  return await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${scenarioOrigin}/api/auth${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: scenarioOrigin,
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** The id of the user a session cookie signs in. */
export async function sessionUserId(ctx: BackofficeScenarioContext, cookie: string) {
  const session = await authRequest(ctx, cookie, "/get-session");
  return z.object({ user: z.object({ id: z.string() }) }).parse(await session.json()).user.id;
}

/**
 * Adds the Backoffice access token to a session cookie, as the auth bootstrap does. Its claims
 * carry the user's role and active organization at the time it is issued.
 */
export async function withBackofficeAccessToken(
  ctx: BackofficeScenarioContext,
  cookie: string,
  organizationId: string | null,
) {
  const issued = await authRequest(
    ctx,
    cookie,
    "/backoffice-token",
    organizationId ? { selection: "required", organizationId } : { selection: "preferred" },
  );
  assert(issued.ok, await issued.clone().text());
  const accessToken = /fragno-backoffice\.access_token=([^;]+)/u.exec(
    issued.headers.get("set-cookie") ?? "",
  )?.[1];
  assert(accessToken);
  return `${cookie}; fragno-backoffice.access_token=${accessToken}`;
}

/** Creates an Automations project in an organization and returns its identity. */
export async function createAutomationProject(
  ctx: BackofficeScenarioContext,
  input: { orgId: string; name: string; createdByUserId: string },
) {
  const response = await ctx.runtime.objects.automations.forOrg(input.orgId).http.fetch(
    new Request(`${scenarioOrigin}/api/automations/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: input.name, createdByUserId: input.createdByUserId }),
    }),
  );
  assert(response.ok, await response.clone().text());
  return z.object({ id: z.string(), slug: z.string() }).parse(await response.json());
}

/** Archives an Automations project, which hides its scope from Backoffice routes. */
export async function archiveAutomationProject(
  ctx: BackofficeScenarioContext,
  input: { orgId: string; projectId: string },
) {
  const response = await ctx.runtime.objects.automations.forOrg(input.orgId).http.fetch(
    new Request(`${scenarioOrigin}/api/automations/projects/${input.projectId}`, {
      method: "DELETE",
    }),
  );
  assert(response.ok, await response.clone().text());
}
