// admin tools
type AdminCodemodeProvider = {
  /** Create an email-bound link that authorizes one Backoffice account sign-up and email it to the invitee. */
  signupInvitationsCreate(
    input: AdminSignupInvitationsCreateInput,
  ): Promise<AdminSignupInvitationsCreateOutput>;
  /** Create an organization and assign its owner. */
  orgCreate(input: AdminOrgCreateInput): Promise<AdminOrgCreateOutput>;
  /** Add a user to an organization with explicit roles. */
  orgMembersAdd(input: AdminOrgMembersAddInput): Promise<AdminOrgMembersAddOutput>;
  /** Remove a user from an organization. */
  orgMembersRemove(input: AdminOrgMembersRemoveInput): Promise<AdminOrgMembersRemoveOutput>;
  /** List every organization, using cursor pagination. */
  orgList(input: AdminOrgListInput): Promise<AdminOrgListOutput>;
  /** Read one organization by slug. */
  orgGet(input: AdminOrgGetInput): Promise<AdminOrgGetOutput>;
  /** List members of any organization with their roles, using cursor pagination. */
  orgMembersList(input: AdminOrgMembersListInput): Promise<AdminOrgMembersListOutput>;
  /** Register a Backoffice app for an existing Better Auth OAuth client. Does not provision OAuth credentials or install the app. */
  appsCreate(input: AdminAppsCreateInput): Promise<AdminAppsCreateOutput>;
  /** List global Backoffice app registrations using cursor pagination. Does not expose OAuth credentials or organization installations. */
  appsList(input: AdminAppsListInput): Promise<AdminAppsListOutput>;
  /** Create an Auth-owned authorization-code OAuth web or native client for the current System administrator. Confidential clients return an initial secret and may use client credentials; public clients use PKCE without a secret. Does not register or install a Backoffice app. */
  oauthClientsCreate(input: AdminOauthClientsCreateInput): Promise<AdminOauthClientsCreateOutput>;
  /** List the global Auth-owned OAuth client catalog, including other owners and the internal Codemode client, using cursor pagination. Never exposes credentials or credential hashes. */
  oauthClientsList(input: AdminOauthClientsListInput): Promise<AdminOauthClientsListOutput>;
  /** Replace the redirect URIs, OAuth scopes, and client-credentials access of an OAuth client owned by the current System administrator. Widened scopes apply to new authorizations only; existing users authorize again. */
  oauthClientsUpdate(input: AdminOauthClientsUpdateInput): Promise<AdminOauthClientsUpdateOutput>;
  /** Replace the secret of a confidential OAuth client owned by the current System administrator. The previous secret stops working immediately; the new one is returned once. */
  oauthClientsRotateSecret(
    input: AdminOauthClientsRotateSecretInput,
  ): Promise<AdminOauthClientsRotateSecretOutput>;
  /** Feature a published Marketplace listing, optionally scheduled with startsAt and ending at until, ordered by priority (higher first) with an optional curator note. Featuring an already featured listing replaces its settings. Expired and unpublished entries are removed to make room. System scope curates the public Marketplace (System administrators); organization scope curates that organization's Marketplace (owners and admins). */
  marketplaceFeature(input: AdminMarketplaceFeatureInput): Promise<AdminMarketplaceFeatureOutput>;
  /** Remove a Marketplace listing's feature entry. Removing an entry that does not exist succeeds with removed false. System scope curates the public Marketplace (System administrators); organization scope curates that organization's Marketplace (owners and admins). */
  marketplaceUnfeature(
    input: AdminMarketplaceUnfeatureInput,
  ): Promise<AdminMarketplaceUnfeatureOutput>;
  /** Publish the bundled static marketplace entries from System context. */
  marketplacePushStatic(
    input: AdminMarketplacePushStaticInput,
  ): Promise<AdminMarketplacePushStaticOutput>;
};
declare const admin: AdminCodemodeProvider;

type DirectoryPageInput = {
  pageSize?: number;
  cursor?: string | null;
};
type OrganizationPage = {
  organizations: OrganizationRecord[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type OrganizationRecord = {
  organizationId: string;
  name: string;
  slug: string;
  /** ISO 8601 datetime string. */
  createdAt: string;
};
type OrganizationMemberPage = {
  members: OrganizationMemberRecord[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type OrganizationMemberRecord = {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  /** ISO 8601 datetime string. */
  joinedAt: string;
};
type BackofficePermissionRequirement =
  | {
      namespace: "account";
      permission: "read";
    }
  | {
      namespace: "account";
      permission: "manage";
    }
  | {
      namespace: "admin";
      permission: "apps.manage";
    }
  | {
      namespace: "admin";
      permission: "apps.read";
    }
  | {
      namespace: "admin";
      permission: "oauth-clients.manage";
    }
  | {
      namespace: "admin";
      permission: "oauth-clients.read";
    }
  | {
      namespace: "admin";
      permission: "sign-up-invitations.manage";
    }
  | {
      namespace: "admin";
      permission: "organizations.manage";
    }
  | {
      namespace: "apps";
      permission: "read";
    }
  | {
      namespace: "apps";
      permission: "manage";
    }
  | {
      namespace: "capabilities";
      permission: "read";
    }
  | {
      namespace: "cloudflare";
      permission: "browserRun";
    }
  | {
      namespace: "connections";
      permission: "manage";
    }
  | {
      namespace: "connections";
      permission: "read";
    }
  | {
      namespace: "events";
      permission: "emit";
    }
  | {
      namespace: "events";
      permission: "manage";
    }
  | {
      namespace: "events";
      permission: "read";
    }
  | {
      namespace: "events";
      permission: "route";
    }
  | {
      namespace: "forms";
      permission: "create";
    }
  | {
      namespace: "forms";
      permission: "read";
    }
  | {
      namespace: "forms";
      permission: "update";
    }
  | {
      namespace: "hooks";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "link";
    }
  | {
      namespace: "identity";
      permission: "bind";
    }
  | {
      namespace: "identity";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "resolve";
    }
  | {
      namespace: "identity";
      permission: "revoke";
    }
  | {
      namespace: "integrations";
      permission: "read";
    }
  | {
      namespace: "integrations";
      permission: "manage";
    }
  | {
      namespace: "integrations";
      permission: "execute";
    }
  | {
      namespace: "internal";
      permission: "manage";
    }
  | {
      namespace: "org";
      permission: "read";
    }
  | {
      namespace: "org";
      permission: "manage";
    }
  | {
      namespace: "marketplace";
      permission: "read";
    }
  | {
      namespace: "marketplace";
      permission: "publish";
    }
  | {
      namespace: "marketplace";
      permission: "feature";
    }
  | {
      namespace: "packages";
      permission: "read";
    }
  | {
      namespace: "packages";
      permission: "install";
    }
  | {
      namespace: "otp";
      permission: "create";
    }
  | {
      namespace: "pi";
      permission: "manage";
    }
  | {
      namespace: "pi";
      permission: "modify";
    }
  | {
      namespace: "pi";
      permission: "read";
    }
  | {
      namespace: "router";
      permission: "modify";
    }
  | {
      namespace: "router";
      permission: "read";
    }
  | {
      namespace: "sandbox";
      permission: "modify";
    }
  | {
      namespace: "sandbox";
      permission: "read";
    }
  | {
      namespace: "store";
      permission: "modify";
    }
  | {
      namespace: "store";
      permission: "read";
    }
  | {
      namespace: "upload";
      permission: "modify";
    }
  | {
      namespace: "upload";
      permission: "read";
    }
  | {
      namespace: "workflow";
      permission: "executeCode";
    }
  | {
      namespace: "workflow";
      permission: "modify";
    }
  | {
      namespace: "workflow";
      permission: "read";
    };
type BackofficeApp = {
  id: string;
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
  /** ISO 8601 datetime string. */
  createdAt: string;
};
type BackofficeOAuthClientCreateInput = {
  name: string;
  redirectUris: string[];
  scopes: ("openid" | "profile" | "email" | "offline_access" | "backoffice")[];
  clientType?: "confidential" | "public";
  applicationType?: "web" | "native";
  clientCredentials?: boolean;
};
type BackofficeOAuthClientCreateResult =
  | {
      clientType: "confidential";
      clientId: string;
      clientSecret: string;
    }
  | {
      clientType: "public";
      clientId: string;
      clientSecret: null;
    };
type BackofficeOAuthClientListInput = {
  pageSize?: number;
  cursor?: string | null;
};
type BackofficeOAuthClientPage = {
  clients: BackofficeOAuthClientSummary[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type BackofficeOAuthClientSummary = {
  clientId: string;
  name: string | null;
  redirectUris: string[] | null;
  scopes: string[] | null;
  tokenEndpointAuthMethod: string | null;
  userId: string | null;
  referenceId: string | null;
  disabled: boolean | null;
};
type BackofficeOAuthClientUpdateInput = {
  clientId: string;
  redirectUris: string[];
  scopes: ("openid" | "profile" | "email" | "offline_access" | "backoffice")[];
  clientCredentials: boolean;
};
type BackofficeOAuthClientUpdateResult = {
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  clientCredentials: boolean;
};
type BackofficeOAuthClientRotateSecretInput = {
  clientId: string;
};
type BackofficeOAuthClientRotateSecretResult = {
  clientId: string;
  clientSecret: string;
};
type AdminSignupInvitationsCreateInput = {
  email: string;
  ttlDays?: number;
};
type AdminSignupInvitationsCreateOutput = {
  invitationId: string;
  email: string;
  url: string;
  ttlDays: number;
};
type AdminOrgCreateInput = {
  name: string;
  slug: string;
  ownerEmail: string;
};
type AdminOrgCreateOutput = {
  organizationId: string;
  name: string;
  slug: string;
  ownerUserId: string;
};
type AdminOrgMembersAddInput = {
  organizationSlug: string;
  userEmail: string;
  roles: ("owner" | "admin" | "member")[];
};
type AdminOrgMembersAddOutput = {
  organizationId: string;
  userId: string;
  roles: string[];
};
type AdminOrgMembersRemoveInput = {
  organizationSlug: string;
  userEmail: string;
};
type AdminOrgMembersRemoveOutput = {
  organizationId: string;
  userId: string;
  roles: string[];
};
type AdminOrgListInput = DirectoryPageInput;
type AdminOrgListOutput = OrganizationPage;
type AdminOrgGetInput = {
  organizationSlug: string;
};
type AdminOrgGetOutput = OrganizationRecord;
type AdminOrgMembersListInput = {
  pageSize?: number;
  cursor?: string | null;
  organizationSlug: string;
};
type AdminOrgMembersListOutput = OrganizationMemberPage;
type AdminAppsCreateInput = {
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
};
type AdminAppsCreateOutput = {
  appId: string;
  created: boolean;
};
type AdminAppsListInput = {
  pageSize?: number;
  cursor?: string | null;
};
type AdminAppsListOutput = {
  apps: BackofficeApp[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type AdminOauthClientsCreateInput = BackofficeOAuthClientCreateInput;
type AdminOauthClientsCreateOutput = BackofficeOAuthClientCreateResult;
type AdminOauthClientsListInput = BackofficeOAuthClientListInput;
type AdminOauthClientsListOutput = BackofficeOAuthClientPage;
type AdminOauthClientsUpdateInput = BackofficeOAuthClientUpdateInput;
type AdminOauthClientsUpdateOutput = BackofficeOAuthClientUpdateResult;
type AdminOauthClientsRotateSecretInput = BackofficeOAuthClientRotateSecretInput;
type AdminOauthClientsRotateSecretOutput = BackofficeOAuthClientRotateSecretResult;
type AdminMarketplaceFeatureInput = {
  listingId: string;
  startsAt?: string | null;
  until?: string | null;
  priority?: number;
  note?: string | null;
};
type AdminMarketplaceFeatureOutput = {
  listingId: string;
  name: string;
  state: "active" | "scheduled" | "expired" | "hidden";
  priority: number;
  note: string | null;
  startsAt: string;
  until: string | null;
  featuredBy: string;
  createdAt: string;
  updatedAt: string;
};
type AdminMarketplaceUnfeatureInput = {
  listingId: string;
};
type AdminMarketplaceUnfeatureOutput = {
  listingId: string;
  removed: boolean;
};
type AdminMarketplacePushStaticInput = {
  force?: boolean;
};
type AdminMarketplacePushStaticOutput = {
  publications: (
    | {
        listingId: string;
        slug: string;
        version: string;
        state: "published";
      }
    | {
        listingId: string;
        slug: string;
        version: string;
        workflowInstanceId: string;
        state: "requested";
        workflowStatus: "active";
      }
    | {
        listingId: string;
        slug: string;
        version: string;
        workflowInstanceId: string;
        state: "pending";
        workflowStatus: "active" | "waiting" | "paused";
      }
    | {
        listingId: string;
        slug: string;
        version: string;
        workflowInstanceId: string;
        state: "failed";
        workflowStatus: "errored" | "terminated" | "complete";
        error: {
          name: string;
          message: string;
        };
      }
  )[];
};
