import type { UploadChecksum } from "@fragno-dev/upload";

import type { UploadFileAssertion, UploadFileWritePrecondition } from "@/files/contributors/upload";

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
  source: MarketplaceIngestionSourceFile;
  target: MarketplaceWorkspaceTargetFile | null;
};

export type MarketplaceWorkspaceWrite = {
  source: MarketplaceIngestionSourceFile;
  precondition: UploadFileWritePrecondition;
  mode?: number;
};

export type MarketplaceWorkspaceUpdatePlan = {
  writes: MarketplaceWorkspaceWrite[];
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
  previousSourceFilesByPath: ReadonlyMap<string, MarketplaceIngestionSourceFile>;
}): MarketplaceWorkspaceUpdatePlan => {
  const writes: MarketplaceWorkspaceWrite[] = [];
  const assertions: UploadFileAssertion[] = [];

  for (const { source, target } of input.observations) {
    if (!target) {
      writes.push({
        source,
        precondition: { kind: "absent" },
        ...(source.mode === null ? {} : { mode: source.mode }),
      });
      continue;
    }

    const targetPrecondition = { kind: "revision" as const, revision: target.revision };
    if (marketplaceFileContentsMatch(source, target)) {
      assertions.push({
        path: `/workspace/${source.relativePath}`,
        precondition: targetPrecondition,
      });
      continue;
    }

    const installedSource = input.previousSourceFilesByPath.get(source.relativePath);
    if (installedSource && marketplaceFileContentsMatch(installedSource, target)) {
      writes.push({ source, precondition: targetPrecondition });
      continue;
    }

    throw new MarketplaceWorkspaceFileConflictError(source.relativePath);
  }

  return { writes, assertions };
};
