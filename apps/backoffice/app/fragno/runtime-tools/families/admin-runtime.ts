import type { AppActionsDeclaration } from "@fragno-dev/backoffice-api/v0/apps";

import type {
  AuthObject,
  AutomationsObject,
  OtpObject,
  ResendObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";
import { buildSignUpInvitationEmail } from "@/transactional-emails/sign-up-invitation";

import type { AdminRuntime } from "./admin";
import { compileIntegrationActionSchema } from "./integrations/integration-action-json-schema";

/**
 * Apps' actions are validated with the same compiler integrations.execute uses, so a contract it
 * cannot enforce is rejected when declared rather than published unchecked.
 */
function assertAppActionContractsEnforceable(actions: AppActionsDeclaration) {
  if (actions.kind === "none") {
    return;
  }
  for (const action of actions.actions) {
    if (action.inputSchema.type !== "object") {
      throw new Error(`App action '${action.id}' must declare an object input schema.`);
    }
    for (const [label, schema] of [
      ["input", action.inputSchema],
      ["output", action.outputSchema],
    ] as const) {
      if (compileIntegrationActionSchema(schema) === null) {
        throw new Error(
          `App action '${action.id}' has an ${label} schema Backoffice cannot validate. Use JSON Schema 2020-12 or draft-07 without $dynamicRef, $vocabulary, or unresolved references.`,
        );
      }
    }
  }
}

type AdminAuthCommands = Pick<
  AuthObject,
  | "getOAuthClientFacts"
  | "createAdminOAuthClient"
  | "listAdminOAuthClients"
  | "updateAdminOAuthClient"
  | "rotateAdminOAuthClientSecret"
  | "createAdminOrganization"
  | "verifyAdminUserEmail"
  | "getOrganizationBySlug"
  | "getOrganization"
  | "listOrganizations"
  | "listOrganizationMembers"
  | "addAdminOrganizationMember"
  | "removeAdminOrganizationMember"
  | "setOrganizationManager"
>;

type AdminOtpCommands = Pick<OtpObject, "issueSignUpInvitation">;

type AdminResendCommands = Pick<ResendObject, "queueEmail">;

type AdminRuntimeDependencies = {
  auth: AdminAuthCommands;
  apps: BackofficeAppsCommands | null;
  otp: AdminOtpCommands | null;
  resend: AdminResendCommands | null;
  automationsForOrg: (organizationId: string) => Pick<AutomationsObject, "deleteEventsOfType">;
  publicBaseUrl: string | null;
};

async function requireAdminOrganizationId(auth: AdminAuthCommands, organizationSlug: string) {
  const organization = await auth.getOrganizationBySlug(organizationSlug);
  if (!organization) {
    throw new Error(
      `Admin organization command could not find organization slug '${organizationSlug}'.`,
    );
  }
  return organization.id;
}

/** Creates the system administration runtime backed by singleton Backoffice objects. */
export function createAdminRuntime({
  auth,
  apps,
  otp,
  resend,
  automationsForOrg,
  publicBaseUrl,
}: AdminRuntimeDependencies): AdminRuntime {
  return {
    createOAuthClient: async (input, administratorUserId) =>
      await auth.createAdminOAuthClient({ ...input, administratorUserId }),
    listOAuthClients: async (input, administratorUserId) =>
      await auth.listAdminOAuthClients({ ...input, administratorUserId }),
    updateOAuthClient: async (input, administratorUserId) =>
      await auth.updateAdminOAuthClient({ ...input, administratorUserId }),
    rotateOAuthClientSecret: async (input, administratorUserId) =>
      await auth.rotateAdminOAuthClientSecret({ ...input, administratorUserId }),
    createApp: async (input) => {
      if (!apps) {
        throw new Error("Admin app creation requires the APPS binding.");
      }
      const client = await auth.getOAuthClientFacts({ clientId: input.oauthClientId });
      if (!client) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' was not found. List clients with admin.oauth-clients.list.`,
        );
      }
      // The Codemode client always receives first-party authority, so an app registration for it
      // could be installed but never used.
      if (client.managedByBackoffice) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' is the deployment's Codemode client and cannot be registered as an app. Create a dedicated client with admin.oauth-clients.create.`,
        );
      }
      // Without this scope the app could be installed but never exchange for execution access.
      if (!client.scopes.includes("backoffice")) {
        throw new Error(
          `OAuth client '${input.oauthClientId}' must allow the backoffice scope before it can be registered as an app. Update it with admin.oauth-clients.update.`,
        );
      }
      assertAppActionContractsEnforceable(input.actions);
      return requireBackofficeAppOperationValue(await apps.registerApp(input));
    },
    updateAppActions: async (input) => {
      if (!apps) {
        throw new Error("Admin app action updates require the APPS binding.");
      }
      assertAppActionContractsEnforceable(input.actions);
      return requireBackofficeAppOperationValue(await apps.updateAppActions(input));
    },
    updateAppPermissions: async (input) => {
      if (!apps) {
        throw new Error("Admin app permission updates require the APPS binding.");
      }
      return requireBackofficeAppOperationValue(await apps.updateAppPermissions(input));
    },
    updateAppTrust: async (input) => {
      if (!apps) {
        throw new Error("Admin app trust updates require the APPS binding.");
      }
      return requireBackofficeAppOperationValue(await apps.updateAppTrust(input));
    },
    listApps: async (input) => {
      if (!apps) {
        throw new Error("Admin app listing requires the APPS binding.");
      }
      return requireBackofficeAppOperationValue(await apps.listApps(input));
    },
    createSignUpInvitation: async (input) => {
      if (!otp) {
        throw new Error("Admin sign-up invitation creation requires the OTP binding.");
      }
      if (!resend) {
        throw new Error("Admin sign-up invitation creation requires the RESEND binding.");
      }
      if (!publicBaseUrl) {
        throw new Error(
          "Admin sign-up invitation creation requires DOCS_PUBLIC_BASE_URL to be configured.",
        );
      }

      const invitation = await otp.issueSignUpInvitation({
        ...input,
        publicBaseUrl,
      });
      await resend.queueEmail(
        await buildSignUpInvitationEmail({
          email: invitation.email,
          invitationUrl: invitation.url,
          ttlDays: invitation.ttlDays,
          publicBaseUrl,
        }),
        { idempotencyKey: `admin:sign-up-invitation:${invitation.issuanceId}`, senderName: null },
      );
      return {
        invitationId: invitation.invitationId,
        email: invitation.email,
        url: invitation.url,
        ttlDays: invitation.ttlDays,
      };
    },
    verifyUserEmail: async (input) => await auth.verifyAdminUserEmail(input),
    createOrganization: async (input) => await auth.createAdminOrganization(input),
    listOrganizations: async (input) => await auth.listOrganizations(input),
    deleteOrganizationEventsOfType: async ({ organizationSlug, ...pass }) =>
      await automationsForOrg(
        await requireAdminOrganizationId(auth, organizationSlug),
      ).deleteEventsOfType(pass),
    getOrganization: async ({ organizationSlug }) => {
      const organization = await auth.getOrganization({
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      });
      if (!organization) {
        throw new Error(`Admin organization command could not find slug '${organizationSlug}'.`);
      }
      return organization;
    },
    listOrganizationMembers: async ({ organizationSlug, ...page }) =>
      await auth.listOrganizationMembers({
        ...page,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
    addOrganizationMember: async ({ organizationSlug, ...input }) =>
      await auth.addAdminOrganizationMember({
        ...input,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
    removeOrganizationMember: async ({ organizationSlug, ...input }) =>
      await auth.removeAdminOrganizationMember({
        ...input,
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
      }),
    setOrganizationManager: async ({ organizationSlug, managingOrganizationSlug }) =>
      await auth.setOrganizationManager({
        organizationId: await requireAdminOrganizationId(auth, organizationSlug),
        managingOrganizationId:
          managingOrganizationSlug === null
            ? null
            : await requireAdminOrganizationId(auth, managingOrganizationSlug),
      }),
  };
}
