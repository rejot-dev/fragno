// Package installs into the workspace. Read to install a Marketplace package or list installed ones.
type PackagesCodemodeProvider = {
  /**
   * Start the Marketplace installation workflow in the current workspace at a required folder under /workspace. Installs from the public Marketplace, or from the installing organization's Marketplace with organization visibility. Installation is asynchronous: follow workflowInstanceId with packages.status. Pass the release's declared permissions, which marketplace.view returns, to approve them; the install is refused unless they match exactly, and you must hold each one. A workspace holds one installation per listing: installing another version upgrades it in place, replacing and removing files that still match the installed version, and fails without changes if a file it would replace was edited. Installing the installed version again re-runs its install workflow, which is how its settings are changed. Omit version to use the latest release.
   * Requires `packages.install`.
   */
  install(input: PackagesInstallInput): Promise<PackagesInstallOutput>;
  /**
   * Get where an installation started with packages.install stands, by the workflowInstanceId and workflowScope it returned, or null when this workspace has no such installation. A complete run has recorded the installation, which packages.get reads; a failed one says why. installer is the package's own install workflow, null for packages without one or until it starts. While it waits, such as for the package's settings, read the event types it waits for with workflow.getInstance and send them with workflow.sendEvent, both in the workflowScope organization.
   * Requires `packages.read`.
   */
  status(input: PackagesStatusInput): Promise<PackagesStatusOutput>;
  /**
   * List the package installations in the current workspace.
   * Requires `packages.read`.
   */
  ls(input: PackagesLsInput): Promise<PackagesLsOutput>;
  /**
   * Get one package installation in the current workspace, including its settings, or null when the listing is not installed. Package workflows read their settings this way.
   * Requires `packages.read`.
   */
  get(input: PackagesGetInput): Promise<PackagesGetOutput>;
  /**
   * Uninstall a package from the current workspace: delete the agents, routes, and event definitions it manages and its installation record. Its files stay in its installation folder. Uninstalling a listing that is not installed changes nothing and returns null.
   * Requires `packages.install`.
   */
  uninstall(input: PackagesUninstallInput): Promise<PackagesUninstallOutput>;
  /**
   * Import the installations recorded in the legacy workspace file /workspace/marketplace-lock.json, from before Backoffice kept installation records, then delete the file. Installing into a workspace that still has it is refused. Imported installations approve no permissions and have no settings until the package is installed again, and routes and agents their old install scripts wrote stay members' until then. A listing that already has an installation keeps it. A listing the file records in several folders is a conflict: it is not imported, and the file stays, until keep names the one folder to import; the other folders' files stay where they are. If the file changes while importing, it stays and lock is changed; import again to pick up the changes.
   * Requires `packages.install`.
   */
  importLegacy(input: PackagesImportLegacyInput): Promise<PackagesImportLegacyOutput>;
};
declare const packages: PackagesCodemodeProvider;

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
        | "access-codes.manage"
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
      permission: "classify" | "generateImage" | "extract" | "run";
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
      namespace: "web";
      permission: "download";
    }
  | {
      namespace: "workflow";
      permission: "executeCode" | "modify" | "read";
    };
type PackagesInstallInput = {
  installationRoot: string;
  listingId: string;
  version?: string;
  permissions?: BackofficePermissionRequirement[];
  visibility?: "public" | "organization";
};
type PackagesInstallOutput = {
  listingId: string;
  version: string;
  workflowInstanceId: string;
  action: "created" | "restarted" | "unchanged";
  workflowStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  installationRoot: string;
  workflowScope: {
    kind: "org";
    orgId: string;
    jurisdiction: "eu" | "us" | null;
  };
};
type PackagesStatusInput = {
  workflowInstanceId: string;
  workflowScope: {
    kind: "org";
    orgId: string;
    jurisdiction?: "eu" | "us" | null;
  };
};
type PackagesStatusOutput =
  | {
      listingId: string;
      version: string;
      installationRoot: string;
      status: "active" | "paused" | "waiting" | "complete";
      installer: {
        workflowInstanceId: string;
        status: "active" | "paused" | "waiting" | "complete" | "errored" | "terminated";
      } | null;
    }
  | {
      listingId: string;
      version: string;
      installationRoot: string;
      status: "errored" | "terminated";
      error: {
        name: string;
        message: string;
      };
      installer: {
        workflowInstanceId: string;
        status: "active" | "paused" | "waiting" | "complete" | "errored" | "terminated";
      } | null;
    }
  | null;
type PackagesLsInput = Record<string, unknown>;
type PackagesLsOutput = {
  installations: {
    marketplace:
      | {
          kind: "system";
        }
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        };
    listingId: string;
    version: string;
    installationRoot: string;
    permissions: BackofficePermissionRequirement[];
    settings: {
      [key: string]: unknown;
    };
  }[];
};
type PackagesGetInput = {
  listingId: string;
};
type PackagesGetOutput = {
  marketplace:
    | {
        kind: "system";
      }
    | {
        kind: "org";
        orgId: string;
        jurisdiction: "eu" | "us" | null;
      };
  listingId: string;
  version: string;
  installationRoot: string;
  permissions: BackofficePermissionRequirement[];
  settings: {
    [key: string]: unknown;
  };
} | null;
type PackagesUninstallInput = {
  listingId: string;
};
type PackagesUninstallOutput = {
  installation: {
    marketplace:
      | {
          kind: "system";
        }
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        };
    listingId: string;
    version: string;
    installationRoot: string;
    permissions: BackofficePermissionRequirement[];
    settings: {
      [key: string]: unknown;
    };
  };
  removedRouteIds: string[];
  removedEventDefinitions: {
    source: string;
    eventType: string;
  }[];
  removedAgents: string[];
} | null;
type PackagesImportLegacyInput = {
  keep?: {
    listingId: string;
    installationRoot: string;
  }[];
};
type PackagesImportLegacyOutput = {
  imported: {
    marketplace:
      | {
          kind: "system";
        }
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        };
    listingId: string;
    version: string;
    installationRoot: string;
    permissions: BackofficePermissionRequirement[];
    settings: {
      [key: string]: unknown;
    };
  }[];
  alreadyInstalled: {
    listingId: string;
    installationRoot: string;
  }[];
  conflicts: {
    listingId: string;
    installationRoots: string[];
  }[];
  lock: "absent" | "deleted" | "kept" | "changed";
};
