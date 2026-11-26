import type {
  AppInstallationExternalAccount,
  BackofficeAppInstallation,
} from "@fragno-dev/backoffice-api/v0/apps";
import type { AutomationActor, AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import {
  backofficeScopeContains,
  backofficeScopeRootOwner,
  type BackofficeContextScope,
  type BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  BackofficeAuthorityResolver,
  BackofficeGrant,
} from "@/backoffice-runtime/authority-resolver";
import {
  backofficeExecutionScopeRestriction,
  type BackofficeDeferredExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";

import {
  appInstallationReaches,
  appInstallationTargetScope,
  type AppInstallationOwner,
  type AppInstallationTargetScope,
  type AppMemberReachConsent,
} from "./contracts";

const APP_INSTALLATION_ACTOR_TYPE = "app-installation";
const appInstallationActorIdPattern = /^(.+):([1-9][0-9]*)$/;

type InstalledAppActivation = { appId: string; activation: number };

/** Who an installed app acts as: a signed-in member, or the installation itself. */
export type InstalledAppActor = { kind: "user"; userId: string } | { kind: "installation" };

const INSTALLED_APP_EVENT_SOURCE_PREFIX = "app:";

/** The source of every event an installed app emits, and of its linked external account. */
export function installedAppEventSource(appId: string): string {
  return `${INSTALLED_APP_EVENT_SOURCE_PREFIX}${appId}`;
}

/** Automations trust these sources, so only the app's own credential may emit them. */
export function isInstalledAppEventSource(source: string): boolean {
  return source.startsWith(INSTALLED_APP_EVENT_SOURCE_PREFIX);
}

/**
 * Creates execution for an installed app inside the owner's resources it was approved for.
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
  scope: AppInstallationTargetScope;
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
                  source: installedAppEventSource(installation.appId),
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
 * The principal as a delegate, when it is an installed app acting as itself, of work that follows
 * from what it did; null for any other principal. A delegate only narrows what that work may do.
 */
export function installedAppAsDelegate(
  principal: AutomationActor<"principal"> | null,
): AutomationActor<"delegate"> | null {
  return principal && installedAppActivationFromActor(principal)
    ? { ...principal, role: "delegate" }
    : null;
}

/** The installed app an execution acts through, as itself or for a user, or `null` for none. */
export function installedAppIdOfActors(actors: AutomationActors): string | null {
  for (const actor of [actors.principal, ...actors.delegation]) {
    const activation = actor ? installedAppActivationFromActor(actor) : null;
    if (activation) {
      return activation.appId;
    }
  }
  return null;
}

/**
 * Work an installed app does for a member of an organization, in the member's own personal
 * workspace: exactly that scope, never their projects or another person's, and only while the
 * member is the principal. Whether the app may act there is the resolver's to decide.
 */
export type MemberReachUse = {
  workspace: BackofficeUserContextScope;
  origin: { scope: AppInstallationTargetScope; orgId: string };
  installation: InstalledAppActivation;
  installationActor: AutomationActors["delegation"][number];
};

/**
 * How `execution` reaches its principal's personal workspace: when it is there, outside the scope
 * restriction of the organization's installation it acts through. Null for anything else,
 * including work inside the restriction.
 */
export function memberReachUse(execution: BackofficeExecutionContext): MemberReachUse | null {
  const { scope } = execution;
  const { principal, delegation } = execution.actors;
  const restriction = backofficeExecutionScopeRestriction(execution);
  const origin = restriction && appInstallationTargetScope(restriction);
  const originOwner = origin && backofficeScopeRootOwner(origin);
  const installationActor = delegation.find(
    (actor) => installedAppActivationFromActor(actor) !== null,
  );
  const installation = installationActor && installedAppActivationFromActor(installationActor);
  if (
    !origin ||
    originOwner?.kind !== "org" ||
    !installationActor ||
    !installation ||
    principal?.scope !== "internal" ||
    principal.type !== "user" ||
    scope.kind !== "user" ||
    scope.userId !== principal.id ||
    backofficeScopeContains(origin, scope)
  ) {
    return null;
  }
  return {
    workspace: scope,
    origin: { scope: origin, orgId: originOwner.orgId },
    installation,
    installationActor,
  };
}

/**
 * Whether a context for `target` may be made for `execution`: its principal's own personal
 * workspace, for an installed app acting for them. The context grants nothing; each call through it
 * is authorized.
 */
export function mayReachMemberWorkspace(
  execution: BackofficeExecutionContext,
  target: BackofficeContextScope,
): boolean {
  return memberReachUse({ ...execution, scope: target }) !== null;
}

/**
 * Resolves app-installation actors from the activation that issued them: their current grants,
 * only inside the approved resources. Other actors fall through to `resolver`. Organization
 * administration, including `apps.*`, is resolved by the control-plane resolver that wraps this
 * one and is never available to an app.
 *
 * In a member's personal workspace, an app acting for them has the grants of the organization's
 * installation the work comes from, while that installation reaches members, the member let in
 * that installation, and they still belong to the organization.
 */
export function createAppInstallationAuthorityResolver({
  resolver,
  installations,
  organizations,
}: {
  resolver: BackofficeAuthorityResolver;
  installations: {
    getInstallation(input: {
      owner: AppInstallationOwner;
      appId: string;
    }): Promise<BackofficeAppInstallation | null>;
    getMemberReachConsent(input: {
      owner: BackofficeUserContextScope;
      appId: string;
      orgId: string;
    }): Promise<AppMemberReachConsent | null>;
  };
  organizations: {
    hasAccess(input: { orgId: string; userId: string }): Promise<boolean>;
  };
}): BackofficeAuthorityResolver {
  async function activeInstallationReaching(
    activation: InstalledAppActivation,
    target: AppInstallationTargetScope,
  ): Promise<BackofficeAppInstallation | null> {
    const installation = await installations.getInstallation({
      owner: backofficeScopeRootOwner(target),
      appId: activation.appId,
    });
    return installation?.status === "active" &&
      installation.activation === activation.activation &&
      appInstallationReaches(installation, target)
      ? installation
      : null;
  }

  async function resolveInstallationGrants(
    activation: InstalledAppActivation,
    execution: BackofficeExecutionContext,
  ): Promise<readonly BackofficeGrant[]> {
    const use = memberReachUse(execution);
    if (use) {
      // The organization decides whether its installation reaches members and what it may do; the
      // member whether it enters their workspace, for this installation of the app only.
      const [installation, consent, member] = await Promise.all([
        activeInstallationReaching(activation, use.origin.scope),
        installations.getMemberReachConsent({
          owner: use.workspace,
          appId: activation.appId,
          orgId: use.origin.orgId,
        }),
        organizations.hasAccess({ orgId: use.origin.orgId, userId: use.workspace.userId }),
      ]);
      return installation?.memberReach.kind === "consenting" &&
        consent?.activation === activation.activation &&
        member
        ? installation.grantedPermissions
        : [];
    }
    const target = appInstallationTargetScope(execution.scope);
    if (!target) {
      return [];
    }
    const installation = await activeInstallationReaching(activation, target);
    return installation ? installation.grantedPermissions : [];
  }

  return {
    async resolvePrincipalPermissions(input, operations) {
      const installationPrincipal = installedAppActivationFromActor(input.principal);
      return installationPrincipal
        ? await resolveInstallationGrants(installationPrincipal, input.execution)
        : await resolver.resolvePrincipalPermissions(input, operations);
    },
    async resolveActorCapabilityGrants(input) {
      const installationDelegate =
        input.actor.role === "delegate" ? installedAppActivationFromActor(input.actor) : null;
      return installationDelegate
        ? await resolveInstallationGrants(installationDelegate, input.execution)
        : await resolver.resolveActorCapabilityGrants(input);
    },
  };
}
