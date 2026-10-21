// apps tools
type AppsCodemodeProvider = {
  /** Review a registered app's requested permissions and declared actions before approving an installation. */
  get(input: AppsGetInput): Promise<AppsGetOutput>;
  /** Approve an app installation in the selected organization or personal scope, limited to explicit permissions and resources, and approve the app's declared actions at the reviewed revision. Installer identity comes from the authenticated user. */
  install(input: AppsInstallInput): Promise<AppsInstallOutput>;
  /** Inspect one app installation in the selected organization or personal scope, including approved grants. */
  getInstallation(input: AppsGetInstallationInput): Promise<AppsGetInstallationOutput>;
  /** List the selected organization's or personal scope's active and uninstalled apps using cursor pagination. Does not expose other owners or OAuth credentials. */
  listInstallations(input: AppsListInstallationsInput): Promise<AppsListInstallationsOutput>;
  /** Replace an active installation's approved permissions and resources. Takes effect immediately, including for issued app credentials. Does not change installer attribution. */
  updateInstallation(input: AppsUpdateInstallationInput): Promise<AppsUpdateInstallationOutput>;
  /** Approve an app's current action declaration for the selected owner's installation, so its new and changed actions run. Only needed when the app's changeApproval is installation. */
  approveInstallationActions(
    input: AppsApproveInstallationActionsInput,
  ): Promise<AppsApproveInstallationActionsOutput>;
  /** Uninstall an app in the selected organization or personal scope, clearing approved grants and its linked account while retaining installation identity. Immediately invalidates app credentials. Does not revoke personal OAuth consent. */
  uninstall(input: AppsUninstallInput): Promise<AppsUninstallOutput>;
};
declare const apps: AppsCodemodeProvider;

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
      namespace: "admin";
      permission: "users.manage";
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
      namespace: "models";
      permission: "classify";
    }
  | {
      namespace: "models";
      permission: "generateImage";
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
      namespace: "projects";
      permission: "create";
    }
  | {
      namespace: "projects";
      permission: "read";
    }
  | {
      namespace: "reson8";
      permission: "transcribe";
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
        | "projects.provision"
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
type AppInstallationResourceScope =
  | {
      kind: "owner";
    }
  | {
      kind: "projects";
      projectIds: string[];
    };
type BackofficeAppInstallationMutationResult = {
  installationId: string;
  changed: boolean;
};
type BackofficeAppInstallation = {
  id: string;
  appId: string;
  owner:
    | {
        kind: "org";
        orgId: string;
      }
    | {
        kind: "user";
        userId: string;
      };
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope: AppInstallationResourceScope;
  externalAccount: {
    id: string;
    label: string;
  } | null;
  installedByUserId: string;
  status: "active" | "uninstalled";
  activation: number;
  /** The app's actionsRevision this installation approved; 0 when it approved no declaration. */
  approvedActionsRevision: number;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
};
type BackofficeAppInstallationPage = {
  installations: BackofficeAppInstallation[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type AppsGetInput = {
  appId: string;
};
type AppsGetOutput = BackofficeApp | null;
type AppsInstallInput = {
  appId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope?: AppInstallationResourceScope;
  /** The actionsRevision reviewed with apps.get; installation fails if the declaration changed since. */
  actionsRevision: number;
};
type AppsInstallOutput = BackofficeAppInstallationMutationResult;
type AppsGetInstallationInput = {
  appId: string;
};
type AppsGetInstallationOutput = BackofficeAppInstallation | null;
type AppsListInstallationsInput = {
  pageSize?: number;
  cursor?: string | null;
};
type AppsListInstallationsOutput = BackofficeAppInstallationPage;
type AppsUpdateInstallationInput = {
  appId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope: AppInstallationResourceScope;
};
type AppsUpdateInstallationOutput = BackofficeAppInstallationMutationResult;
type AppsApproveInstallationActionsInput = {
  appId: string;
  /** The actionsRevision reviewed with apps.get; approval fails if the declaration changed since. */
  actionsRevision: number;
};
type AppsApproveInstallationActionsOutput = BackofficeAppInstallationMutationResult;
type AppsUninstallInput = {
  appId: string;
};
type AppsUninstallOutput = BackofficeAppInstallationMutationResult;
