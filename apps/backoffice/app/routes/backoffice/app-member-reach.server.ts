import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type {
  BackofficeOrganizationContextScope,
  BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { RouterContextProvider } from "react-router";
import { z } from "zod";

import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import { backofficePersonalScope } from "@/backoffice-runtime/resolved-scope";
import type { AppMemberReachConsent } from "@/fragno/app-installations/contracts";
import { BackofficeAppDomainError, requireBackofficeAppOperationValue } from "@/fragno/apps/errors";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { appConnectionName } from "@/fragno/runtime-tools/families/integrations/app-integration";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

export class AppMemberReachRequestError extends Error {
  override readonly name = "AppMemberReachRequestError";
}

/** The organization's active installation of the app, which a consent lets in at its activation. */
export type AppMemberReachInstallation = {
  activation: number;
  /** Whether the organization lets the app ask its members, without which no consent lets it in. */
  organizationAllows: boolean;
};

export type AppMemberReachPage = {
  appId: string;
  appName: string;
  organization: { id: string; name: string };
  /**
   * Whether the app asks for members' workspaces. Only then may the person let it in anew; a
   * consent they gave goes on letting it in when it stops asking, until they stop it.
   */
  appAsks: boolean;
  /** Null when the app is not active in the organization, or the person is not a member. */
  installation: AppMemberReachInstallation | null;
  /**
   * What the person stored, and whether it is for the installation there now; only then can it let
   * the app in.
   */
  consent: (AppMemberReachConsent & { forInstallation: boolean }) | null;
};

/** The person's own scope; only onboarded people have one, which the caller has established. */
function personalScopeOf(me: BackofficeMeData): BackofficeUserContextScope {
  const personal = backofficePersonalScope(me.user);
  if (!personal) {
    throw new Error("An onboarded person has a personal scope.");
  }
  return personal;
}

/**
 * The app, the person's organization, and the organization's active installation of the app, as
 * far as each exists for the person: an organization they do not belong to has none.
 */
async function readAppInOrganization(
  context: Readonly<RouterContextProvider>,
  input: { me: BackofficeMeData; appId: string; orgId: string },
) {
  const { runtime } = context.get(BackofficeWorkerContext);
  const [app, membership] = await Promise.all([
    runtime.objects.apps.singleton().commands.getApp({ appId: input.appId }),
    runtime.objects.auth.singleton().commands.getOrganizationMembership({
      organizationId: input.orgId,
      userId: input.me.user.id,
    }),
  ]);
  if (!app || !membership) {
    return { app, organization: membership?.organization ?? null, installation: null };
  }
  const scope: BackofficeOrganizationContextScope = {
    kind: "org",
    orgId: membership.organization.organizationId,
    jurisdiction: membership.organization.jurisdiction,
  };
  const installation = await runtime.objects.appInstallations
    .for(scope)
    .commands.getInstallation({ appId: app.id });
  return {
    app,
    organization: membership.organization,
    installation: installation?.status === "active" ? installation : null,
  };
}

/**
 * The page for an app in an organization: to let it in, or to stop a stored consent, which stays
 * stoppable when the app, its installation, or the person's membership is gone. Otherwise the
 * organization is as unknown as one that does not exist.
 */
export async function loadAppMemberReach(
  context: Readonly<RouterContextProvider>,
  input: { me: BackofficeMeData; appId: string; orgId: string },
): Promise<AppMemberReachPage> {
  const { runtime } = context.get(BackofficeWorkerContext);
  const [{ app, organization, installation }, consent] = await Promise.all([
    readAppInOrganization(context, input),
    runtime.objects.appInstallations
      .for(personalScopeOf(input.me))
      .commands.getMemberReachConsent({ appId: input.appId, orgId: input.orgId }),
  ]);
  const appAsks = app?.requestedMemberReach.kind === "consenting";
  if (!consent && !(appAsks && installation)) {
    throw new AppMemberReachRequestError(
      "This application does not ask for your personal workspace in that organization.",
    );
  }
  return {
    appId: input.appId,
    appName: app ? await appConnectionName(runtime, app) : input.appId,
    organization: organization
      ? { id: organization.organizationId, name: organization.name }
      : await namedOrganization(context, input.orgId),
    appAsks,
    installation: installation
      ? {
          activation: installation.activation,
          organizationAllows: installation.memberReach.kind === "consenting",
        }
      : null,
    consent: consent
      ? { ...consent, forInstallation: consent.activation === installation?.activation }
      : null,
  };
}

/** An organization the person no longer belongs to, by name while it exists. */
async function namedOrganization(context: Readonly<RouterContextProvider>, orgId: string) {
  const { runtime } = context.get(BackofficeWorkerContext);
  const organization = await runtime.objects.auth
    .singleton()
    .commands.getOrganization({ organizationId: orgId });
  return { id: orgId, name: organization?.name ?? orgId };
}

export type AppMemberReachDecisionResult =
  | { status: "saved" }
  | { status: "invalid"; message: string };

const decisionSchema = z.discriminatedUnion("intent", [
  // The activation the page showed, so a reinstalled app is never let in unseen.
  z.strictObject({ intent: z.literal("allow"), activation: z.coerce.number().int().positive() }),
  z.strictObject({ intent: z.literal("stop") }),
]);

/**
 * Records that the signed-in person lets the app into their personal workspace for the
 * organization, or stops it. Only the person decides: the consent lives in their own scope, never
 * one they administer. Stopping needs nothing but their own consent.
 */
export async function decideAppMemberReach(
  context: Readonly<RouterContextProvider>,
  input: { me: BackofficeMeData; appId: string; orgId: string; formData: FormData },
): Promise<AppMemberReachDecisionResult> {
  const intent = input.formData.get("intent");
  const decision = decisionSchema.safeParse(
    intent === "allow" ? { intent, activation: input.formData.get("activation") } : { intent },
  );
  if (!decision.success) {
    return { status: "invalid", message: "Choose whether to let it in." };
  }
  const personal = personalScopeOf(input.me);
  const { runtime, kernel } = context.get(BackofficeWorkerContext);
  const installations = runtime.objects.appInstallations.for(personal).commands;
  const lookup = { appId: input.appId, orgId: input.orgId };
  let change: () => ReturnType<typeof installations.stopMemberReach>;
  if (decision.data.intent === "allow") {
    const { app, installation } = await readAppInOrganization(context, input);
    if (app?.requestedMemberReach.kind !== "consenting" || !installation) {
      throw new AppMemberReachRequestError(
        "This application does not ask for your personal workspace in that organization.",
      );
    }
    if (installation.activation !== decision.data.activation) {
      return {
        status: "invalid",
        message:
          "The organization installed this app again since you opened this page. Review it again.",
      };
    }
    const { activation } = decision.data;
    change = () => installations.allowMemberReach({ ...lookup, activation });
  } else {
    change = () => installations.stopMemberReach(lookup);
  }
  try {
    await kernel.invoke({
      execution: createBackofficeUserExecution({ scope: personal, userId: input.me.user.id }),
      operation: BACKOFFICE_PERMISSION.apps.manage,
      resource: { kind: "app-member-reach", ...lookup },
      execute: async () => requireBackofficeAppOperationValue(await change()),
    });
  } catch (error) {
    if (error instanceof BackofficeAppDomainError) {
      return { status: "invalid", message: error.message };
    }
    throw error;
  }
  return { status: "saved" };
}
