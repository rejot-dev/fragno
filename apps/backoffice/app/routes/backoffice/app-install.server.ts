import { backofficeApiOperationSummary } from "@fragno-dev/backoffice-api/api";
import { backofficeApiV0 } from "@fragno-dev/backoffice-api/v0";
import type {
  AppActionsDeclaration,
  AppInstallationResourceScope,
  AppTrust,
  BackofficeAppInstallation,
} from "@fragno-dev/backoffice-api/v0/apps";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import type { AppInstallationOwner } from "@/fragno/app-installations/contracts";
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
    owner: z.string().min(1),
    permissions: z.array(z.string().min(1)),
    resources: z.enum(["owner", "projects"]),
    projectIds: z.array(z.string().min(1)),
    // The revision the page showed, so actions changed since are not approved unseen.
    actionsRevision: z.coerce.number().int().positive(),
  }),
]);

export type AppInstallRequest = {
  client: { clientId: string; name: string };
  app: {
    id: string;
    requestedPermissions: BackofficePermissionRequirement[];
    actions: AppActionsDeclaration;
    actionsRevision: number;
    trust: AppTrust;
  };
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
    app: {
      id: app.id,
      requestedPermissions: app.requestedPermissions,
      actions: app.actions,
      actionsRevision: app.actionsRevision,
      trust: app.trust,
    },
    redirectUri: query.data.redirect_uri,
    state: query.data.state,
  };
}

/**
 * What each requested permission lets the app do. Apps reach Backoffice only through the API, so
 * that is the summaries of the API operations requiring it; an operation runs only once all of its
 * permissions are granted.
 */
export function describeAppPermissions(
  permissions: readonly BackofficePermissionRequirement[],
): { permission: string; operations: string[] }[] {
  const operations = Object.values(backofficeApiV0.operations);
  return permissions.map(({ namespace, permission }) => ({
    permission: `${namespace}.${permission}`,
    operations: operations
      .filter((operation) =>
        operation.permissions.some(
          (required) => required.namespace === namespace && required.permission === permission,
        ),
      )
      .map(backofficeApiOperationSummary),
  }));
}

/** Where an installation may go, named in the form by the owner's scope segment. */
type AppInstallOwnerChoice = { value: string; label: string; owner: AppInstallationOwner };

/** Where this user may approve installations: organizations they own or administer, and themselves. */
async function listAppInstallOwners(
  context: Readonly<RouterContextProvider>,
  userId: string,
): Promise<AppInstallOwnerChoice[]> {
  const { runtime } = context.get(BackofficeWorkerContext);
  const me = await runtime.objects.auth
    .singleton()
    .commands.getBackofficeMe({ userId, activeOrganizationId: null });
  const organizations = (me?.organizations ?? [])
    .filter(({ member }) => member.roles.some((role) => role === "owner" || role === "admin"))
    .map(({ organization }) => ({
      label: organization.name,
      owner: { kind: "org", orgId: organization.id } as const,
    }));
  // Listed first, an organization is the default: most apps are installed for one.
  return [...organizations, { label: "Personal", owner: { kind: "user", userId } } as const].map(
    (choice) => ({ ...choice, value: backofficeScopePathSegment(choice.owner) }),
  );
}

/** The install page's choices of owner, with the selected owner's projects and installation. */
export async function loadAppInstallChoices(
  context: Readonly<RouterContextProvider>,
  input: { userId: string; appId: string; selectedOwner: string | null },
) {
  const { runtime } = context.get(BackofficeWorkerContext);
  const owners = await listAppInstallOwners(context, input.userId);
  // The personal scope is always offered, so there is always a selection.
  const selected = owners.find(({ value }) => value === input.selectedOwner) ?? owners[0];

  const projectsResponse = await createAutomationsRouteCaller({
    object: runtime.objects.automations.for(selected.owner),
  })("GET", "/projects", {});
  // An unavailable project list must not look like "no projects": the page would then offer only
  // access to everything the owner has.
  if (projectsResponse.type !== "json") {
    throw new Error(
      `Projects for '${selected.value}' could not be loaded (${projectsResponse.status}).`,
    );
  }
  const projects = z
    .array(z.object({ id: z.unknown(), name: z.string(), archivedAt: z.unknown().nullable() }))
    .parse(projectsResponse.data)
    .filter(({ archivedAt }) => archivedAt === null)
    .map(({ id, name }) => ({ id: String(id), name }));
  const installation = await runtime.objects.appInstallations
    .for(selected.owner)
    .commands.getInstallation({ appId: input.appId });
  return {
    owners: owners.map(({ value, label }) => ({ value, label })),
    selectedOwner: { value: selected.value, kind: selected.owner.kind },
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
    owner: input.formData.get("owner") ?? undefined,
    permissions: input.formData.getAll("permission"),
    resources: input.formData.get("resources") ?? undefined,
    projectIds: input.formData.getAll("projectId"),
    actionsRevision: input.formData.get("actionsRevision") ?? undefined,
  });
  if (!decision.success) {
    return { status: "invalid", message: "Choose where to install and the access to approve." };
  }
  if (decision.data.intent === "cancel") {
    return {
      status: "redirect",
      location: redirectToApp(input.request, { error: "access_denied" }),
    };
  }
  // Only an offered owner may be chosen; the kernel still checks live authority below.
  const chosenOwner = decision.data.owner;
  const owner = (await listAppInstallOwners(context, input.userId)).find(
    ({ value }) => value === chosenOwner,
  )?.owner;
  if (!owner) {
    return { status: "invalid", message: "Choose where to install and the access to approve." };
  }
  const { projectIds, actionsRevision } = decision.data;
  if (decision.data.resources === "projects" && projectIds.length === 0) {
    return { status: "invalid", message: "Select at least one project, or everything." };
  }
  const resourceScope: AppInstallationResourceScope =
    decision.data.resources === "owner"
      ? { kind: "owner" }
      : { kind: "projects", projectIds: [...new Set(projectIds)].sort() };
  // Backoffice operates a first-party app, so linking it reviews nothing: it gets what it asks
  // for, everywhere the owner has.
  const access =
    input.request.app.trust.kind === "first-party"
      ? {
          appId: input.request.app.id,
          grantedPermissions: input.request.app.requestedPermissions,
          resourceScope: { kind: "owner" } as const,
        }
      : {
          appId: input.request.app.id,
          grantedPermissions: readGrantedPermissions(
            input.request.app.requestedPermissions,
            decision.data.permissions,
          ),
          resourceScope,
        };

  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const installations = runtime.objects.appInstallations.for(owner).commands;
  let installation: BackofficeAppInstallation | null;
  try {
    installation = await kernel.invoke({
      execution: createBackofficeUserExecution({ scope: owner, userId: input.userId }),
      operation: BACKOFFICE_PERMISSION.apps.manage,
      resource: { kind: "app-installation", appId: access.appId },
      execute: async () => {
        const existing = await installations.getInstallation({ appId: access.appId });
        if (existing?.status === "active") {
          requireBackofficeAppOperationValue(await installations.updateInstallationAccess(access));
          requireBackofficeAppOperationValue(
            await installations.approveActions({ appId: access.appId, actionsRevision }),
          );
        } else {
          requireBackofficeAppOperationValue(
            await installations.installApp({
              ...access,
              installedByUserId: input.userId,
              actionsRevision,
            }),
          );
        }
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
    owner,
    activation: installation.activation,
  });
  return { status: "redirect", location: redirectToApp(input.request, { code }) };
}
