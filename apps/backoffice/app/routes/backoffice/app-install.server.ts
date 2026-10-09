import type {
  AppInstallationResourceScope,
  BackofficeAppInstallation,
} from "@fragno-dev/backoffice-api/v0/apps";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BackofficeAppDomainError, requireBackofficeAppOperationValue } from "@/fragno/apps/errors";
import { createAutomationsRouteCaller } from "@/fragno/automation/route-callers";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

/** The app supplies these; each is validated against Auth and the registry before use. */
const installRequestQuerySchema = z.object({
  client_id: z.string().min(1).max(191),
  redirect_uri: z.url({ protocol: /^https?$/ }),
  state: z.string().min(1).max(512),
});

const installDecisionSchema = z.discriminatedUnion("intent", [
  // Cancelling ignores whatever else the form contained.
  z.object({ intent: z.literal("cancel") }),
  z.strictObject({
    intent: z.literal("install"),
    organizationId: z.string().min(1),
    permissions: z.array(z.string().min(1)),
    resources: z.enum(["organization", "projects"]),
    projectIds: z.array(z.string().min(1)),
  }),
]);

export type AppInstallRequest = {
  client: { clientId: string; name: string };
  app: { id: string; requestedPermissions: BackofficePermissionRequirement[] };
  redirectUri: string;
  state: string;
};

export class AppInstallRequestError extends Error {
  override readonly name = "AppInstallRequestError";
}

/**
 * Validates an app-initiated installation request. The redirect must share an origin with one of
 * the client's registered OAuth redirect URIs, so this page cannot be used as an open redirect.
 */
export async function resolveAppInstallRequest(
  context: Readonly<RouterContextProvider>,
  url: URL,
): Promise<AppInstallRequest> {
  const query = installRequestQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) {
    throw new AppInstallRequestError(
      "This installation link is missing a client, return address, or state.",
    );
  }
  const { runtime } = context.get(BackofficeWorkerContext);
  const client = await runtime.objects.auth
    .singleton()
    .commands.getOAuthClientFacts({ clientId: query.data.client_id });
  if (!client || client.disabled) {
    throw new AppInstallRequestError("This application is not available.");
  }
  const app = await runtime.objects.apps
    .singleton()
    .commands.getAppByOAuthClientId({ oauthClientId: client.clientId });
  if (!app) {
    throw new AppInstallRequestError("This application is not registered as a Backoffice app.");
  }
  const redirectOrigin = new URL(query.data.redirect_uri).origin;
  if (!client.redirectUris.some((registered) => new URL(registered).origin === redirectOrigin)) {
    throw new AppInstallRequestError("This installation link returns to an unregistered address.");
  }
  return {
    client: { clientId: client.clientId, name: client.name ?? client.clientId },
    app: { id: app.id, requestedPermissions: app.requestedPermissions },
    redirectUri: query.data.redirect_uri,
    state: query.data.state,
  };
}

/** Organizations where this user may approve installations, with the selected one's details. */
export async function loadAppInstallChoices(
  context: Readonly<RouterContextProvider>,
  input: { userId: string; appId: string; selectedOrganizationId: string | null },
) {
  const { runtime } = context.get(BackofficeWorkerContext);
  const me = await runtime.objects.auth
    .singleton()
    .commands.getBackofficeMe({ userId: input.userId, activeOrganizationId: null });
  const organizations = (me?.organizations ?? [])
    .filter(({ member }) => member.roles.some((role) => role === "owner" || role === "admin"))
    .map(({ organization }) => ({ id: organization.id, name: organization.name }));
  const selected =
    organizations.find(({ id }) => id === input.selectedOrganizationId) ?? organizations[0];
  if (!selected) {
    return { organizations, selectedOrganizationId: null, projects: [], installation: null };
  }

  const projectsResponse = await createAutomationsRouteCaller({
    object: runtime.objects.automations.forOrg(selected.id),
  })("GET", "/projects", {});
  // An unavailable project list must not look like "no projects": the page would then offer only
  // whole-organization access.
  if (projectsResponse.type !== "json") {
    throw new Error(
      `Projects for organization '${selected.id}' could not be loaded (${projectsResponse.status}).`,
    );
  }
  const projects = z
    .array(z.object({ id: z.unknown(), name: z.string(), archivedAt: z.unknown().nullable() }))
    .parse(projectsResponse.data)
    .filter(({ archivedAt }) => archivedAt === null)
    .map(({ id, name }) => ({ id: String(id), name }));
  const installation = await runtime.objects.appInstallations
    .forOrg(selected.id)
    .commands.getInstallation({ appId: input.appId });
  return {
    organizations,
    selectedOrganizationId: selected.id,
    projects,
    installation: installation?.status === "active" ? installation : null,
  };
}

export type AppInstallDecisionResult =
  | { status: "redirect"; location: string }
  | { status: "invalid"; message: string };

function redirectToApp(request: AppInstallRequest, params: Record<string, string>): string {
  const location = new URL(request.redirectUri);
  for (const [name, value] of Object.entries({ ...params, state: request.state })) {
    location.searchParams.set(name, value);
  }
  return location.toString();
}

function readGrantedPermissions(
  requested: readonly BackofficePermissionRequirement[],
  selected: readonly string[],
): BackofficePermissionRequirement[] {
  return requested.filter(({ namespace, permission }) =>
    selected.includes(`${namespace}.${permission}`),
  );
}

/**
 * Approves (or updates) the installation through the kernel as the signed-in user, then returns
 * the user to the app with a code its server can redeem. The kernel checks live owner/admin
 * authority, so a stale membership cannot approve.
 */
export async function decideAppInstallation(
  context: Readonly<RouterContextProvider>,
  input: { userId: string; request: AppInstallRequest; formData: FormData },
): Promise<AppInstallDecisionResult> {
  const decision = installDecisionSchema.safeParse({
    intent: input.formData.get("intent"),
    organizationId: input.formData.get("organizationId") ?? undefined,
    permissions: input.formData.getAll("permission"),
    resources: input.formData.get("resources") ?? undefined,
    projectIds: input.formData.getAll("projectId"),
  });
  if (!decision.success) {
    return { status: "invalid", message: "Choose an organization and the access to approve." };
  }
  if (decision.data.intent === "cancel") {
    return {
      status: "redirect",
      location: redirectToApp(input.request, { error: "access_denied" }),
    };
  }
  const { organizationId, projectIds } = decision.data;
  if (decision.data.resources === "projects" && projectIds.length === 0) {
    return {
      status: "invalid",
      message: "Select at least one project, or the whole organization.",
    };
  }
  const resourceScope: AppInstallationResourceScope =
    decision.data.resources === "organization"
      ? { kind: "organization" }
      : { kind: "projects", projectIds: [...new Set(projectIds)].sort() };
  const access = {
    appId: input.request.app.id,
    grantedPermissions: readGrantedPermissions(
      input.request.app.requestedPermissions,
      decision.data.permissions,
    ),
    resourceScope,
  };

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const installations = runtime.objects.appInstallations.forOrg(organizationId).commands;
  let installation: BackofficeAppInstallation | null;
  try {
    installation = await kernel.invoke({
      execution: createBackofficeUserExecution({
        scope: { kind: "org", orgId: organizationId },
        userId: input.userId,
      }),
      operation: BACKOFFICE_PERMISSION.apps.manage,
      resource: { kind: "app-installation", appId: access.appId },
      execute: async () => {
        const existing = await installations.getInstallation({ appId: access.appId });
        requireBackofficeAppOperationValue(
          existing?.status === "active"
            ? await installations.updateInstallationAccess(access)
            : await installations.installApp({ ...access, installedByUserId: input.userId }),
        );
        return await installations.getInstallation({ appId: access.appId });
      },
    });
  } catch (error) {
    if (isBackofficeForbiddenError(error)) {
      return {
        status: "invalid",
        message: "Only an owner or admin of this organization can install apps.",
      };
    }
    if (error instanceof BackofficeAppDomainError) {
      return { status: "invalid", message: error.message };
    }
    throw error;
  }
  if (installation?.status !== "active") {
    throw new Error("The approved app installation could not be read back.");
  }
  const { code } = await runtime.objects.auth.singleton().commands.issueAppInstallationCode({
    appId: access.appId,
    organizationId,
    activation: installation.activation,
  });
  return { status: "redirect", location: redirectToApp(input.request, { code }) };
}
