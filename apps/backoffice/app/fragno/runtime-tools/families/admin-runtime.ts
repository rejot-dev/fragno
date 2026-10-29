import type { AppActionsDeclaration } from "@fragno-dev/backoffice-api/v0/apps";
import type { BackofficeOrganizationContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  AuthCommands,
  AutomationsCommands,
  OtpCommands,
} from "@/backoffice-runtime/object-registry";
import { backofficeOrganizationContextScope } from "@/backoffice-runtime/resolved-scope";
import { buildAccessCodeSignUpUrl } from "@/fragno/access-codes/access-code";
import type { AccessCodeRecord } from "@/fragno/access-codes/contracts";
import type { BackofficeAppsCommands } from "@/fragno/apps/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";

import type { AdminAccessCode, AdminRuntime } from "./admin";
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
  AuthCommands,
  | "getOAuthClientFacts"
  | "createAdminOAuthClient"
  | "listAdminOAuthClients"
  | "updateAdminOAuthClient"
  | "rotateAdminOAuthClientSecret"
  | "createAdminOrganization"
  | "verifyAdminUserEmail"
  | "getOrganizationBySlug"
  | "getOrganization"
  | "getOrganizationRelations"
  | "listOrganizations"
  | "listOrganizationMembers"
  | "addAdminOrganizationMember"
  | "removeAdminOrganizationMember"
  | "setOrganizationManager"
>;

type AdminOtpCommands = Pick<
  OtpCommands,
  "createAccessCode" | "listAccessCodes" | "listAccessCodeRedemptions" | "revokeAccessCode"
>;

type AdminRuntimeDependencies = {
  auth: AdminAuthCommands;
  apps: BackofficeAppsCommands | null;
  otp: AdminOtpCommands | null;
  automationsFor: (
    organization: BackofficeOrganizationContextScope,
  ) => Pick<AutomationsCommands, "deleteEventsOfType">;
  publicBaseUrl: string | null;
};

async function requireAdminOrganization(auth: AdminAuthCommands, organizationSlug: string) {
  const organization = await auth.getOrganizationBySlug(organizationSlug);
  if (!organization) {
    throw new Error(
      `Admin organization command could not find organization slug '${organizationSlug}'.`,
    );
  }
  return organization;
}

function withSignUpUrl(publicBaseUrl: string, accessCode: AccessCodeRecord): AdminAccessCode {
  return { ...accessCode, url: buildAccessCodeSignUpUrl(publicBaseUrl, accessCode.code) };
}

async function requireAdminOrganizationId(auth: AdminAuthCommands, organizationSlug: string) {
  return (await requireAdminOrganization(auth, organizationSlug)).id;
}

/** Creates the system administration runtime backed by singleton Backoffice objects. */
export function createAdminRuntime({
  auth,
  apps,
  otp,
  automationsFor,
  publicBaseUrl,
}: AdminRuntimeDependencies): AdminRuntime {
  /** Access codes are shared as sign-up links, which need the public origin. */
  function requireAccessCodeLinks(operation: string) {
    if (!otp) {
      throw new Error(`Admin access code ${operation} requires the OTP binding.`);
    }
    if (!publicBaseUrl) {
      throw new Error(
        `Admin access code ${operation} requires DOCS_PUBLIC_BASE_URL to be configured.`,
      );
    }
    return { otp, publicBaseUrl };
  }

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
    createAccessCode: async (input) => {
      const { otp, publicBaseUrl } = requireAccessCodeLinks("creation");
      const created = await otp.createAccessCode(input);
      if (!created.ok) {
        throw new Error(
          `An access code ${created.code} already exists; give this one another label.`,
        );
      }
      return withSignUpUrl(publicBaseUrl, created.accessCode);
    },
    listAccessCodes: async ({ pageSize, cursor }) => {
      const { otp, publicBaseUrl } = requireAccessCodeLinks("listing");
      const listing = await otp.listAccessCodes(
        cursor === null ? { page: "first", pageSize } : { page: "next", cursor },
      );
      if (!listing.ok) {
        throw new Error("The access code cursor is not from a previous page of access codes.");
      }
      return {
        ...listing.page,
        accessCodes: listing.page.accessCodes.map((accessCode) =>
          withSignUpUrl(publicBaseUrl, accessCode),
        ),
      };
    },
    listAccessCodeRedemptions: async ({ code, pageSize, cursor }) => {
      const { otp, publicBaseUrl } = requireAccessCodeLinks("redemption listing");
      const listing = await otp.listAccessCodeRedemptions({
        code,
        pagination: cursor === null ? { page: "first", pageSize } : { page: "next", cursor },
      });
      if (!listing.ok) {
        throw new Error(
          listing.reason === "not_found"
            ? `Access code '${code}' was not found.`
            : "The redemption cursor is not from a previous page of this code's redemptions.",
        );
      }
      return {
        ...listing.page,
        accessCode: withSignUpUrl(publicBaseUrl, listing.accessCode),
      };
    },
    revokeAccessCode: async (input) => {
      if (!otp) {
        throw new Error("Admin access code revocation requires the OTP binding.");
      }
      const accessCode = await otp.revokeAccessCode(input);
      if (!accessCode) {
        throw new Error(`Access code '${input.accessCodeId}' was not found.`);
      }
      return accessCode;
    },
    verifyUserEmail: async (input) => await auth.verifyAdminUserEmail(input),
    createOrganization: async (input) => await auth.createAdminOrganization(input),
    listOrganizations: async (input) => await auth.listOrganizations(input),
    deleteOrganizationEventsOfType: async ({ organizationSlug, ...pass }) => {
      const organization = await requireAdminOrganization(auth, organizationSlug);
      return await automationsFor(
        backofficeOrganizationContextScope(organization),
      ).deleteEventsOfType(pass);
    },
    getOrganization: async ({ organizationSlug }) => {
      const organizationId = await requireAdminOrganizationId(auth, organizationSlug);
      const [organization, relations] = await Promise.all([
        auth.getOrganization({ organizationId }),
        auth.getOrganizationRelations({ organizationId }),
      ]);
      if (!organization) {
        throw new Error(`Admin organization command could not find slug '${organizationSlug}'.`);
      }
      return { ...organization, managingOrganization: relations.managingOrganization };
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
