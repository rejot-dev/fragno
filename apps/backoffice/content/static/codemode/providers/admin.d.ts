// System administration: organizations, sign-ups, app registrations, OAuth clients, Marketplace features. Read in System scope.
type AdminCodemodeProvider = {
  /**
   * Create an email-bound link that authorizes one Backoffice account sign-up and email it to the invitee.
   * Requires `admin.sign-up-invitations.manage`.
   */
  signupInvitationsCreate(
    input: AdminSignupInvitationsCreateInput,
  ): Promise<AdminSignupInvitationsCreateOutput>;
  /**
   * Create an organization and assign its owner.
   * Requires `admin.organizations.manage`.
   */
  orgCreate(input: AdminOrgCreateInput): Promise<AdminOrgCreateOutput>;
  /**
   * Add a user to an organization with explicit roles.
   * Requires `admin.organizations.manage`.
   */
  orgMembersAdd(input: AdminOrgMembersAddInput): Promise<AdminOrgMembersAddOutput>;
  /**
   * Remove a user from an organization.
   * Requires `admin.organizations.manage`.
   */
  orgMembersRemove(input: AdminOrgMembersRemoveInput): Promise<AdminOrgMembersRemoveOutput>;
  /**
   * Let the members of a managing organization, such as an agency, act in an organization: in its workspace, its projects, and, as its owners and admins, its members' personal workspaces. They act with their role in the managing organization, owners as admins, without becoming members. It replaces any previous managing organization and does not chain.
   * Requires `admin.organizations.manage`.
   */
  orgManagerSet(input: AdminOrgManagerSetInput): Promise<AdminOrgManagerSetOutput>;
  /**
   * End an organization's management: only its own members act in it again, effective for new credentials and deferred work at once.
   * Requires `admin.organizations.manage`.
   */
  orgManagerClear(input: AdminOrgManagerClearInput): Promise<AdminOrgManagerClearOutput>;
  /**
   * List every organization, using cursor pagination.
   * Requires `admin.organizations.manage`.
   */
  orgList(input: AdminOrgListInput): Promise<AdminOrgListOutput>;
  /**
   * Read one organization by slug, with the organization managing it, if any.
   * Requires `admin.organizations.manage`.
   */
  orgGet(input: AdminOrgGetInput): Promise<AdminOrgGetOutput>;
  /**
   * List members of any organization with their roles, using cursor pagination.
   * Requires `admin.organizations.manage`.
   */
  orgMembersList(input: AdminOrgMembersListInput): Promise<AdminOrgMembersListOutput>;
  /**
   * Mark a user's email address as verified without sending a verification email, for example on a deployment without email delivery.
   * Requires `admin.users.manage`.
   */
  usersVerifyEmail(input: AdminUsersVerifyEmailInput): Promise<AdminUsersVerifyEmailOutput>;
  /**
   * Register a Backoffice app for an existing Better Auth OAuth client. Does not provision OAuth credentials or install the app.
   * Requires `admin.apps.manage`.
   */
  appsCreate(input: AdminAppsCreateInput): Promise<AdminAppsCreateOutput>;
  /**
   * List global Backoffice app registrations using cursor pagination. Does not expose OAuth credentials or organization installations.
   * Requires `admin.apps.read`.
   */
  appsList(input: AdminAppsListInput): Promise<AdminAppsListOutput>;
  /**
   * Replace a registered app's action declaration. A changed declaration gets a new revision; installations approve it before new or changed actions run, unless its changeApproval is automatic.
   * Requires `admin.apps.manage`.
   */
  appsUpdateActions(input: AdminAppsUpdateActionsInput): Promise<AdminAppsUpdateActionsOutput>;
  /**
   * Replace the permissions a registered app requests. A first-party app's installations follow the new request within a minute. A third-party app's installations keep the grants their owner approved: an added permission applies once an owner grants it (apps.installations.update or the install page), and a removed one stays granted until an owner changes the installation's access.
   * Requires `admin.apps.manage`.
   */
  appsUpdatePermissions(
    input: AdminAppsUpdatePermissionsInput,
  ): Promise<AdminAppsUpdatePermissionsOutput>;
  /**
   * Set whether Backoffice operates a registered app. A first-party app is authorized without a consent screen and cannot be revoked by users, is linked to organizations without a permission review, lets anyone sign up through it, has Backoffice's sign-in speak in its name (its branding), and may call the provisioning operations it is granted.
   * Requires `admin.apps.manage`.
   */
  appsUpdateTrust(input: AdminAppsUpdateTrustInput): Promise<AdminAppsUpdateTrustOutput>;
  /**
   * Create an Auth-owned authorization-code OAuth web or native client for the current System administrator. Confidential clients return an initial secret and may use client credentials; public clients use PKCE without a secret. Does not register or install a Backoffice app.
   * Requires `admin.oauth-clients.manage`.
   */
  oauthClientsCreate(input: AdminOauthClientsCreateInput): Promise<AdminOauthClientsCreateOutput>;
  /**
   * List the global Auth-owned OAuth client catalog, including other owners and the internal Codemode client, using cursor pagination. Never exposes credentials or credential hashes.
   * Requires `admin.oauth-clients.read`.
   */
  oauthClientsList(input: AdminOauthClientsListInput): Promise<AdminOauthClientsListOutput>;
  /**
   * Replace the redirect URIs, OAuth scopes, and client-credentials access of an OAuth client owned by the current System administrator. Widened scopes apply to new authorizations only; existing users authorize again.
   * Requires `admin.oauth-clients.manage`.
   */
  oauthClientsUpdate(input: AdminOauthClientsUpdateInput): Promise<AdminOauthClientsUpdateOutput>;
  /**
   * Replace the secret of a confidential OAuth client owned by the current System administrator. The previous secret stops working immediately; the new one is returned once.
   * Requires `admin.oauth-clients.manage`.
   */
  oauthClientsRotateSecret(
    input: AdminOauthClientsRotateSecretInput,
  ): Promise<AdminOauthClientsRotateSecretOutput>;
  /**
   * Feature a published Marketplace listing, optionally scheduled with startsAt and ending at until, ordered by priority (higher first) with an optional curator note. Featuring an already featured listing replaces its settings. Expired and unpublished entries are removed to make room. System scope curates the public Marketplace (System administrators); organization scope curates that organization's Marketplace (owners and admins).
   * Requires `marketplace.read`.
   */
  marketplaceFeature(input: AdminMarketplaceFeatureInput): Promise<AdminMarketplaceFeatureOutput>;
  /**
   * Remove a Marketplace listing's feature entry. Removing an entry that does not exist succeeds with removed false. System scope curates the public Marketplace (System administrators); organization scope curates that organization's Marketplace (owners and admins).
   * Requires `marketplace.read`.
   */
  marketplaceUnfeature(
    input: AdminMarketplaceUnfeatureInput,
  ): Promise<AdminMarketplaceUnfeatureOutput>;
  /**
   * Publish the bundled static marketplace entries from System context.
   * Requires `internal.manage`.
   */
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
      permission: "read" | "manage";
    }
  | {
      namespace: "admin";
      permission:
        | "apps.manage"
        | "apps.read"
        | "oauth-clients.manage"
        | "oauth-clients.read"
        | "sign-up-invitations.manage"
        | "organizations.manage"
        | "users.manage";
    }
  | {
      namespace: "apps";
      permission: "read" | "manage";
    }
  | {
      namespace: "cloudflare";
      permission: "browserRun";
    }
  | {
      namespace: "connections";
      permission: "manage" | "read";
    }
  | {
      namespace: "events";
      permission: "emit" | "manage" | "read" | "route";
    }
  | {
      namespace: "forms";
      permission: "create" | "read" | "update";
    }
  | {
      namespace: "hooks";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "link" | "bind" | "read" | "resolve" | "revoke";
    }
  | {
      namespace: "integrations";
      permission: "read" | "manage" | "execute";
    }
  | {
      namespace: "internal";
      permission: "manage";
    }
  | {
      namespace: "org";
      permission: "read" | "manage";
    }
  | {
      namespace: "models";
      permission: "classify" | "generateImage";
    }
  | {
      namespace: "marketplace";
      permission: "read" | "publish" | "feature";
    }
  | {
      namespace: "packages";
      permission: "read" | "install";
    }
  | {
      namespace: "otp";
      permission: "create";
    }
  | {
      namespace: "pi";
      permission: "manage" | "modify" | "read";
    }
  | {
      namespace: "projects";
      permission: "create" | "read";
    }
  | {
      namespace: "reson8";
      permission: "transcribe";
    }
  | {
      namespace: "router";
      permission: "modify" | "read";
    }
  | {
      namespace: "sandbox";
      permission: "modify" | "read";
    }
  | {
      namespace: "store";
      permission: "modify" | "read";
    }
  | {
      namespace: "upload";
      permission: "modify" | "read";
    }
  | {
      namespace: "workflow";
      permission: "executeCode" | "modify" | "read";
    };
type AppActionsDeclaration =
  | {
      kind: "none";
    }
  | {
      kind: "endpoint";
      /** Receives each signed action request as a POST; the request token's audience is this URL. */
      endpointUrl: string;
      /** installation: each installation approves a changed declaration before new or changed actions run. automatic: changes apply immediately; only administrators register apps, so reserve it for apps they operate. */
      changeApproval: "installation" | "automatic";
      actions: AppAction[];
    };
type AppTrust =
  | {
      kind: "third-party";
    }
  | {
      kind: "first-party";
      provisioningPermissions: (
        | "organizations.provision"
        | "organizations.provisionForInvitee"
        | "projects.provision"
        | "invitations.create"
        | "invitations.send"
        | "invitations.accept"
      )[];
      branding: AppBranding;
    };
type AppAction = {
  id: string;
  label: string;
  description: string;
  /** JSON Schema (2020-12 or draft-07) for the action's object input. */
  inputSchema: {
    [key: string]: unknown;
  };
  /** JSON Schema (2020-12 or draft-07) for the action's result. */
  outputSchema: {
    [key: string]: unknown;
  };
};
type AppBranding = {
  displayName: string;
  /** A square image shown above the app's sign-in form. */
  logoUrl: string;
  /** Colors the sign-in page's primary button and links. */
  accentColor: string;
  /** Where people return to when they leave the app's sign-in. */
  homeUrl: string;
  /** Where people ask for help signing in. */
  supportUrl: string;
};
type BackofficeApp = {
  id: string;
  /** Unique, permanent name for the app; its integration connection is app#<slug>, e.g. app#bookkeeping. */
  slug: string;
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
  actions: AppActionsDeclaration;
  /** Increments whenever the app's action declaration changes. */
  actionsRevision: number;
  trust: AppTrust;
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
type AdminOrgManagerSetInput = {
  organizationSlug: string;
  managingOrganizationSlug: string;
};
type AdminOrgManagerSetOutput = {
  organizationId: string;
  managingOrganizationId: string | null;
};
type AdminOrgManagerClearInput = {
  organizationSlug: string;
};
type AdminOrgManagerClearOutput = {
  organizationId: string;
  managingOrganizationId: string | null;
};
type AdminOrgListInput = DirectoryPageInput;
type AdminOrgListOutput = OrganizationPage;
type AdminOrgGetInput = {
  organizationSlug: string;
};
type AdminOrgGetOutput = {
  organizationId: string;
  name: string;
  slug: string;
  /** ISO 8601 datetime string. */
  createdAt: string;
  managingOrganization: {
    organizationId: string;
    name: string;
    slug: string;
  } | null;
};
type AdminOrgMembersListInput = {
  pageSize?: number;
  cursor?: string | null;
  organizationSlug: string;
};
type AdminOrgMembersListOutput = OrganizationMemberPage;
type AdminUsersVerifyEmailInput = {
  email: string;
};
type AdminUsersVerifyEmailOutput = {
  userId: string;
  email: string;
  status: "verified" | "already_verified";
};
type AdminAppsCreateInput = {
  /** Unique, permanent name for the app; its integration connection is app#<slug>, e.g. app#bookkeeping. */
  slug: string;
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
  actions?: AppActionsDeclaration;
  trust?: AppTrust;
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
type AdminAppsUpdateActionsInput = {
  appId: string;
  actions: AppActionsDeclaration;
};
type AdminAppsUpdateActionsOutput = {
  actionsRevision: number;
  changed: boolean;
};
type AdminAppsUpdatePermissionsInput = {
  appId: string;
  requestedPermissions: BackofficePermissionRequirement[];
};
type AdminAppsUpdatePermissionsOutput = {
  changed: boolean;
};
type AdminAppsUpdateTrustInput = {
  appId: string;
  trust: AppTrust;
};
type AdminAppsUpdateTrustOutput = {
  changed: boolean;
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
