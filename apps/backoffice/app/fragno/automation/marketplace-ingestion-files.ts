import type { UploadFileWritePrecondition } from "@fragno-dev/upload/types";

import type { UploadChecksum } from "@fragno-dev/upload";

type WorkspaceFileAssertion = { path: string; precondition: UploadFileWritePrecondition };
type WorkspaceFileDeletion = {
  path: string;
  precondition: Extract<UploadFileWritePrecondition, { kind: "revision" }>;
};

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
  relativePath: string;
  requestedSource: MarketplaceIngestionSourceFile | null;
  installedSource: MarketplaceIngestionSourceFile | null;
  target: MarketplaceWorkspaceTargetFile | null;
};

export type MarketplaceWorkspaceWrite = {
  source: MarketplaceIngestionSourceFile;
  precondition: UploadFileWritePrecondition;
};

export type MarketplaceWorkspaceUpdatePlan = {
  writes: MarketplaceWorkspaceWrite[];
  deletions: WorkspaceFileDeletion[];
  assertions: WorkspaceFileAssertion[];
};

export class MarketplaceWorkspaceFileConflictError extends Error {
  constructor(readonly relativePath: string) {
    super(`Marketplace ingestion conflicts with workspace file '/workspace/${relativePath}'.`);
    this.name = "MarketplaceWorkspaceFileConflictError";
  }
}

export const marketplaceFileContentsMatch = (
  source: MarketplaceIngestionSourceFile,
  target: MarketplaceWorkspaceTargetFile | null,
): boolean =>
  target?.checksum?.algo === source.checksum.algo &&
  target.checksum.value === source.checksum.value &&
  target.sizeBytes === source.sizeBytes;

export const planMarketplaceWorkspaceUpdate = (input: {
  observations: MarketplaceWorkspaceFileObservation[];
}): MarketplaceWorkspaceUpdatePlan => {
  const writes: MarketplaceWorkspaceWrite[] = [];
  const deletions: WorkspaceFileDeletion[] = [];
  const assertions: WorkspaceFileAssertion[] = [];

  for (const { relativePath, requestedSource, installedSource, target } of input.observations) {
    const path = `/workspace/${relativePath}`;

    if (!requestedSource) {
      if (!installedSource) {
        throw new Error(`Marketplace update observation '${relativePath}' has no source version.`);
      }
      if (!target) {
        assertions.push({ path, precondition: { kind: "absent" } });
        continue;
      }
      if (!marketplaceFileContentsMatch(installedSource, target)) {
        throw new MarketplaceWorkspaceFileConflictError(relativePath);
      }
      deletions.push({
        path,
        precondition: { kind: "revision", revision: target.revision },
      });
      continue;
    }

    if (!target) {
      writes.push({
        source: requestedSource,
        precondition: { kind: "absent" },
      });
      continue;
    }

    const targetPrecondition = { kind: "revision" as const, revision: target.revision };
    if (marketplaceFileContentsMatch(requestedSource, target)) {
      assertions.push({ path, precondition: targetPrecondition });
      continue;
    }

    if (installedSource && marketplaceFileContentsMatch(installedSource, target)) {
      writes.push({ source: requestedSource, precondition: targetPrecondition });
      continue;
    }

    throw new MarketplaceWorkspaceFileConflictError(relativePath);
  }

  return { writes, deletions, assertions };
};
