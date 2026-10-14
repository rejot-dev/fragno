import type { UploadFileWritePrecondition } from "@fragno-dev/upload/types";

import type { UploadChecksum } from "@fragno-dev/upload";

type WorkspaceFileAssertion = { path: string; precondition: UploadFileWritePrecondition };

export type MarketplaceIngestionSourceFile = {
  fileKey: string;
  relativePath: string;
  contentType: string;
  sizeBytes: number;
  checksum: UploadChecksum;
};

export type MarketplaceWorkspaceTargetFile = {
  revision: number;
  sizeBytes: number;
  checksum: UploadChecksum | null;
};

export type MarketplaceWorkspaceFileObservation = {
  source: MarketplaceIngestionSourceFile;
  /** The installed version's file at the same path; null on a first install or for a new path. */
  previous: MarketplaceIngestionSourceFile | null;
  target: MarketplaceWorkspaceTargetFile | null;
};

/** A file the installed version shipped but the requested version no longer does. */
export type MarketplaceWorkspaceRetiredFileObservation = {
  previous: MarketplaceIngestionSourceFile;
  target: MarketplaceWorkspaceTargetFile | null;
};

export type MarketplaceWorkspaceWrite = {
  source: MarketplaceIngestionSourceFile;
  precondition: UploadFileWritePrecondition;
};

export type MarketplaceWorkspaceInstallationPlan = {
  writes: MarketplaceWorkspaceWrite[];
  deletes: { path: string; revision: number }[];
  assertions: WorkspaceFileAssertion[];
};

export class MarketplaceWorkspaceFileConflictError extends Error {
  constructor(readonly path: string) {
    super(`Marketplace ingestion conflicts with workspace file '${path}'.`);
    this.name = "MarketplaceWorkspaceFileConflictError";
  }
}

/** Matching content permits installation retries without replacing existing workspace files. */
export function marketplaceFileContentsMatch(
  source: MarketplaceIngestionSourceFile,
  target: MarketplaceWorkspaceTargetFile | null,
): boolean {
  return (
    target?.checksum?.algo === source.checksum.algo &&
    target.checksum.value === source.checksum.value &&
    target.sizeBytes === source.sizeBytes
  );
}

/**
 * Installations create missing files and replace or delete files still exactly as the installed
 * version shipped them. A file that differs from both versions was edited in the workspace and
 * conflicts, unless the requested version no longer ships it; then the edit is left in place.
 */
export function planMarketplaceWorkspaceInstallation(input: {
  installationRoot: string;
  observations: MarketplaceWorkspaceFileObservation[];
  retired: MarketplaceWorkspaceRetiredFileObservation[];
}): MarketplaceWorkspaceInstallationPlan {
  const writes: MarketplaceWorkspaceWrite[] = [];
  const deletes: MarketplaceWorkspaceInstallationPlan["deletes"] = [];
  const assertions: WorkspaceFileAssertion[] = [];

  for (const { source, previous, target } of input.observations) {
    const path = `${input.installationRoot}/${source.relativePath}`;
    if (!target) {
      writes.push({ source, precondition: { kind: "absent" } });
    } else if (marketplaceFileContentsMatch(source, target)) {
      assertions.push({ path, precondition: { kind: "revision", revision: target.revision } });
    } else if (previous && marketplaceFileContentsMatch(previous, target)) {
      writes.push({ source, precondition: { kind: "revision", revision: target.revision } });
    } else {
      throw new MarketplaceWorkspaceFileConflictError(path);
    }
  }

  for (const { previous, target } of input.retired) {
    if (target && marketplaceFileContentsMatch(previous, target)) {
      deletes.push({
        path: `${input.installationRoot}/${previous.relativePath}`,
        revision: target.revision,
      });
    }
  }

  return { writes, deletes, assertions };
}
