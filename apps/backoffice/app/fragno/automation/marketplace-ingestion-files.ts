import type { UploadChecksum } from "@fragno-dev/upload";

import type {
  UploadFileAssertion,
  UploadFileDeletion,
  UploadFileWritePrecondition,
} from "@/files/contributors/upload";

export type MarketplaceIngestionSourceFile = {
  fileKey: string;
  relativePath: string;
  contentType: string;
  sizeBytes: number;
  checksum: UploadChecksum;
  mode: number | null;
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
  mode?: number;
};

export type MarketplaceWorkspaceUpdatePlan = {
  writes: MarketplaceWorkspaceWrite[];
  deletions: UploadFileDeletion[];
  assertions: UploadFileAssertion[];
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
  const deletions: UploadFileDeletion[] = [];
  const assertions: UploadFileAssertion[] = [];

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
        ...(requestedSource.mode === null ? {} : { mode: requestedSource.mode }),
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
