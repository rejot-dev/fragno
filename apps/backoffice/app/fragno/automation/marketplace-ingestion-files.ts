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
  target: MarketplaceWorkspaceTargetFile | null;
};

export type MarketplaceWorkspaceWrite = {
  source: MarketplaceIngestionSourceFile;
  precondition: UploadFileWritePrecondition;
};

export type MarketplaceWorkspaceInstallationPlan = {
  writes: MarketplaceWorkspaceWrite[];
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

/** Installations only create missing files; differing existing files are never upgraded. */
export function planMarketplaceWorkspaceInstallation(input: {
  installationRoot: string;
  observations: MarketplaceWorkspaceFileObservation[];
}): MarketplaceWorkspaceInstallationPlan {
  const writes: MarketplaceWorkspaceWrite[] = [];
  const assertions: WorkspaceFileAssertion[] = [];

  for (const { source, target } of input.observations) {
    const path = `${input.installationRoot}/${source.relativePath}`;
    if (!target) {
      writes.push({ source, precondition: { kind: "absent" } });
    } else if (marketplaceFileContentsMatch(source, target)) {
      assertions.push({ path, precondition: { kind: "revision", revision: target.revision } });
    } else {
      throw new MarketplaceWorkspaceFileConflictError(path);
    }
  }

  return { writes, assertions };
}
