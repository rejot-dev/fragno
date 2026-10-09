import type {
  AppInstallationExternalAccount,
  BackofficeAppInstallation,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { AutomationActor } from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeDeferredExecution } from "@/backoffice-runtime/context";

import { appInstallationResourceScopeContains } from "./contracts";

const APP_INSTALLATION_ACTOR_TYPE = "app-installation";
const appInstallationActorIdPattern = /^(.+):([1-9][0-9]*)$/;

type InstalledAppActivation = { appId: string; activation: number };

/** Who an installed app acts as: a signed-in member, or the installation itself. */
export type InstalledAppActor = { kind: "user"; userId: string } | { kind: "installation" };

/**
 * Creates execution for an installed app inside the organization resources it was approved for.
 *
 * Acting for a user, the user stays the principal and the installation activation is a delegate,
 * so the kernel requires the user's current permissions and the installation's current grants.
 * Acting as itself, the installation activation is the principal and only its grants apply. Both
 * are resolved live, which is why this is deferred rather than token-snapshot request execution.
 * Events persist the same actors, so downstream automation keeps the app's restrictions. A claimed
 * external account becomes the initiator of installation-originated work.
 */
export function createInstalledAppExecution({
  scope,
  actor,
  installation,
}: {
  scope: Extract<BackofficeContextScope, { kind: "org" | "project" }>;
  actor: InstalledAppActor;
  installation: InstalledAppActivation & { externalAccount: AppInstallationExternalAccount | null };
}): BackofficeDeferredExecution {
  const installationActorId = `${installation.appId}:${installation.activation}`;
  const appInitiator = {
    scope: "internal",
    type: "app",
    id: installation.appId,
    role: "initiator",
  } as const;
  return {
    kind: "deferred",
    scope,
    scopeRestriction: scope,
    actors:
      actor.kind === "user"
        ? {
            initiator: appInitiator,
            principal: { scope: "internal", type: "user", id: actor.userId, role: "principal" },
            delegation: [
              {
                scope: "internal",
                type: APP_INSTALLATION_ACTOR_TYPE,
                id: installationActorId,
                role: "delegate",
              },
            ],
          }
        : {
            initiator: installation.externalAccount
              ? {
                  scope: "external",
                  source: `app:${installation.appId}`,
                  type: "account",
                  id: installation.externalAccount.id,
                  role: "initiator",
                }
              : appInitiator,
            principal: {
              scope: "internal",
              type: APP_INSTALLATION_ACTOR_TYPE,
              id: installationActorId,
              role: "principal",
            },
            delegation: [],
          },
  };
}

function installedAppActivationFromActor(
  actor: AutomationActor<"principal" | "delegate" | "assistant">,
): InstalledAppActivation | null {
  if (actor.scope !== "internal" || actor.type !== APP_INSTALLATION_ACTOR_TYPE) {
    return null;
  }
  const match = appInstallationActorIdPattern.exec(actor.id);
  return match ? { appId: match[1], activation: Number(match[2]) } : null;
}

/**
 * Resolves app-installation actors from the activation that issued them: their current grants,
 * only inside the approved resources. Other actors fall through to `resolver`. Organization
 * administration, including `apps.*`, is resolved by the control-plane resolver that wraps this
 * one and is never available to an app.
 */
export function createAppInstallationAuthorityResolver({
  resolver,
  installations,
}: {
  resolver: BackofficeAuthorityResolver;
  installations: {
    getInstallation(input: {
      organizationId: string;
      appId: string;
    }): Promise<BackofficeAppInstallation | null>;
  };
}): BackofficeAuthorityResolver {
  async function resolveInstallationGrants(
    activation: InstalledAppActivation,
    scope: BackofficeContextScope,
  ): Promise<readonly BackofficePermissionRequirement[]> {
    if (scope.kind !== "org" && scope.kind !== "project") {
      return [];
    }
    const installation = await installations.getInstallation({
      organizationId: scope.orgId,
      appId: activation.appId,
    });
    if (
      installation?.status !== "active" ||
      installation.activation !== activation.activation ||
      !appInstallationResourceScopeContains(installation.resourceScope, scope)
    ) {
      return [];
    }
    return installation.grantedPermissions;
  }

  return {
    async resolvePrincipalPermissions(input, operations) {
      const installationPrincipal = installedAppActivationFromActor(input.principal);
      return installationPrincipal
        ? await resolveInstallationGrants(installationPrincipal, input.execution.scope)
        : await resolver.resolvePrincipalPermissions(input, operations);
    },
    async resolveActorCapabilityGrants(input) {
      const installationDelegate =
        input.actor.role === "delegate" ? installedAppActivationFromActor(input.actor) : null;
      return installationDelegate
        ? await resolveInstallationGrants(installationDelegate, input.execution.scope)
        : await resolver.resolveActorCapabilityGrants(input);
    },
  };
}
