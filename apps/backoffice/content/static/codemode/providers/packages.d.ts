// Package installs into the workspace. Read to install a Marketplace package or list installed ones.
type PackagesCodemodeProvider = {
  /** Start the existing Marketplace installation workflow in the current workspace at a required folder under /workspace. Installs from the public Marketplace, or from the installing organization's Marketplace with organization visibility. Installation is asynchronous. Installing another version at a folder that already holds the item upgrades it in place, replacing and removing files that still match the installed version; it fails without changes if a file it would replace was edited. Omit version to use the existing latest-release resolution. */
  install(input: PackagesInstallInput): Promise<PackagesInstallOutput>;
  /** List successful package installations recorded in /workspace/marketplace-lock.json for the current workspace. A missing lock is empty; malformed locks fail without being modified. */
  ls(input: PackagesLsInput): Promise<PackagesLsOutput>;
};
declare const packages: PackagesCodemodeProvider;

type PackagesInstallInput = {
  installationRoot: string;
  listingId: string;
  version?: string;
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
  };
};
type PackagesLsInput = Record<string, unknown>;
type PackagesLsOutput = {
  entries: {
    marketplace:
      | {
          kind: "system";
        }
      | {
          kind: "org";
          orgId: string;
        };
    listingId: string;
    version: string;
    installationRoot: string;
  }[];
};
