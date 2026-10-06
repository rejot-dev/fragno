// packages tools
type PackagesCodemodeProvider = {
  /** Start the existing Marketplace installation workflow in the current workspace at a required folder under /workspace. Installation is asynchronous and never overwrites differing files. Omit version to use the existing latest-release resolution. */
  install(input: PackagesInstallInput): Promise<PackagesInstallOutput>;
  /** List successful package installations recorded in /workspace/marketplace-lock.json for the current workspace. A missing lock is empty; malformed locks fail without being modified. */
  ls(input: PackagesLsInput): Promise<PackagesLsOutput>;
};
declare const packages: PackagesCodemodeProvider;

type PackagesInstallInput = {
  installationRoot: string;
  listingId: string;
  version?: string;
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
    listingId: string;
    version: string;
    installationRoot: string;
  }[];
};
