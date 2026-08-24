import { type BetterAuthPlugin } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { organization, type OrganizationOptions } from "better-auth/plugins/organization";

import { createBackofficeOAuthPlugins } from "./better-auth-oauth";

type BetterAuthOrganizationHooks = NonNullable<OrganizationOptions["organizationHooks"]>;

/** Creates every Better Auth plugin that contributes to the persisted auth schema. */
export function createBackofficeBetterAuthSchemaPlugins(input: {
  baseURL: string;
  organizationHooks: BetterAuthOrganizationHooks | null;
}): BetterAuthPlugin[] {
  const organizationOptions = {
    allowUserToCreateOrganization: true,
    creatorRole: "owner",
    schema: {
      organization: {
        additionalFields: {
          createdBy: { type: "string", required: true, input: false },
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
    ...createBackofficeOAuthPlugins(),
  ];
}
