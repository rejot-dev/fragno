import type { BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { organization, type OrganizationOptions } from "better-auth/plugins/organization";

import { createBackofficeOAuthPlugins } from "./better-auth-oauth";
import { createBackofficeOAuthConsentPlugin } from "./better-auth-oauth-consent";

type BetterAuthOrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

/** Role whose membership must remain present for every Backoffice organization. */
export const BACKOFFICE_ORGANIZATION_OWNER_ROLE = "owner";

/** Creates every Better Auth plugin that contributes to the persisted auth schema. */
export function createBackofficeBetterAuthSchemaPlugins(input: {
  baseURL: string;
  organizationHooks: BetterAuthOrganizationHooks | null;
  isUserAdministrator: ((userId: string) => Promise<boolean>) | null;
  listFirstPartyOAuthClientIds: (() => Promise<string[]>) | null;
}): BetterAuthPlugin[] {
  const organizationOptions = {
    allowUserToCreateOrganization: true,
    creatorRole: BACKOFFICE_ORGANIZATION_OWNER_ROLE,
    // Nothing removes an organization's installations, automations, or projects, so deleting one
    // would orphan them.
    disableOrganizationDeletion: true,
    schema: {
      organization: {
        additionalFields: {
          createdBy: { type: "string", required: true, input: false },
          // The organization whose members act in this one, as its admins at most; null when
          // only its own members do. One hop: what this organization manages, they do not reach.
          managingOrganizationId: {
            type: "string",
            required: false,
            input: false,
            references: { model: "organization", field: "id", onDelete: "set null" },
            index: true,
          },
        },
      },
    },
  } satisfies OrganizationOptions;

  return [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    organization(
      input.organizationHooks === null
        ? organizationOptions
        : { ...organizationOptions, organizationHooks: input.organizationHooks },
    ),
    jwt({
      disableSettingJwtHeader: true,
      jwt: {
        issuer: input.baseURL,
        audience: input.baseURL,
        expirationTime: "15m",
      },
    }),
    ...createBackofficeOAuthPlugins({ isUserAdministrator: input.isUserAdministrator }),
    createBackofficeOAuthConsentPlugin({
      listFirstPartyOAuthClientIds: input.listFirstPartyOAuthClientIds,
    }),
  ];
}
