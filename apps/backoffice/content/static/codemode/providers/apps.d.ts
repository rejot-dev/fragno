// apps tools
type AppsCodemodeProvider = {
  /** Review a registered app's requested permissions before approving an installation. */
  get(input: AppsGetInput): Promise<AppsGetOutput>;
  /** Approve an app installation in the selected organization, limited to explicit permissions and resources. Installer identity comes from the authenticated user. */
  install(input: AppsInstallInput): Promise<AppsInstallOutput>;
  /** Inspect one app installation in the selected organization, including approved grants. */
  getInstallation(input: AppsGetInstallationInput): Promise<AppsGetInstallationOutput>;
  /** List the selected organization's active and uninstalled apps using cursor pagination. Does not expose other organizations or OAuth credentials. */
  listInstallations(input: AppsListInstallationsInput): Promise<AppsListInstallationsOutput>;
  /** Replace an active installation's approved permissions and resources. Takes effect immediately, including for issued app credentials. Does not change installer attribution. */
  updateInstallation(input: AppsUpdateInstallationInput): Promise<AppsUpdateInstallationOutput>;
  /** Uninstall an app in the selected organization, clearing approved grants and its linked account while retaining installation identity. Immediately invalidates app credentials. Does not revoke personal OAuth consent. */
  uninstall(input: AppsUninstallInput): Promise<AppsUninstallOutput>;
};
declare const apps: AppsCodemodeProvider;

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
      namespace: "api";
      permission: "connections.create";
    }
  | {
      namespace: "api";
      permission: "connections.delete";
    }
  | {
      namespace: "api";
      permission: "connections.read";
    }
  | {
      namespace: "api";
      permission: "requests.execute";
    }
  | {
      namespace: "api";
      permission: "webhooks.manage";
    }
  | {
      namespace: "api";
      permission: "webhooks.read";
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
      namespace: "github";
      permission: "read";
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
      namespace: "packages";
      permission: "read";
    }
  | {
      namespace: "packages";
      permission: "install";
    }
  | {
      namespace: "mcp";
      permission: "servers.create";
    }
  | {
      namespace: "mcp";
      permission: "servers.delete";
    }
  | {
      namespace: "mcp";
      permission: "servers.read";
    }
  | {
      namespace: "mcp";
      permission: "tools.call";
    }
  | {
      namespace: "connector";
      permission: "providers.read";
    }
  | {
      namespace: "connector";
      permission: "accounts.read";
    }
  | {
      namespace: "connector";
      permission: "connections.create";
    }
  | {
      namespace: "connector";
      permission: "actions.execute";
    }
  | {
      namespace: "otp";
      permission: "create";
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
      namespace: "resend";
      permission: "read";
    }
  | {
      namespace: "resend";
      permission: "send";
    }
  | {
      namespace: "reson8";
      permission: "use";
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
      namespace: "telegram";
      permission: "read";
    }
  | {
      namespace: "telegram";
      permission: "send";
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
type AppsGetInput = {
  appId: string;
};
type AppsGetOutput = {
  id: string;
  oauthClientId: string;
  requestedPermissions: BackofficePermissionRequirement[];
  /** ISO 8601 datetime string. */
  createdAt: string;
} | null;
type AppsInstallInput = {
  appId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope?:
    | {
        kind: "organization";
      }
    | {
        kind: "projects";
        projectIds: string[];
      };
};
type AppsInstallOutput = {
  installationId: string;
  changed: boolean;
};
type AppsGetInstallationInput = {
  appId: string;
};
type AppsGetInstallationOutput = {
  id: string;
  appId: string;
  organizationId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope:
    | {
        kind: "organization";
      }
    | {
        kind: "projects";
        projectIds: unknown;
      };
  externalAccount: {
    id: string;
    label: string;
  } | null;
  installedByUserId: string;
  status: "active" | "uninstalled";
  activation: number;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
} | null;
type AppsListInstallationsInput = {
  pageSize?: number;
  cursor?: string | null;
};
type AppsListInstallationsOutput = {
  installations: {
    id: string;
    appId: string;
    organizationId: string;
    grantedPermissions: BackofficePermissionRequirement[];
    resourceScope:
      | {
          kind: "organization";
        }
      | {
          kind: "projects";
          projectIds: unknown;
        };
    externalAccount: {
      id: string;
      label: string;
    } | null;
    installedByUserId: string;
    status: "active" | "uninstalled";
    activation: number;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type AppsUpdateInstallationInput = {
  appId: string;
  grantedPermissions: BackofficePermissionRequirement[];
  resourceScope:
    | {
        kind: "organization";
      }
    | {
        kind: "projects";
        projectIds: string[];
      };
};
type AppsUpdateInstallationOutput = {
  installationId: string;
  changed: boolean;
};
type AppsUninstallInput = {
  appId: string;
};
type AppsUninstallOutput = {
  installationId: string;
  changed: boolean;
};
