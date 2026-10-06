import type { PreparedFileBatchEntry, PreparedFileWrite } from "@fragno-dev/upload/types";
import { NonRetryableError, type WorkflowStep } from "@fragno-dev/workflows/workflow";

import { listUploadFiles } from "@/file-collection/create-upload-file-collection";
import { marketplaceArtifactFileInventoryMatches } from "@/fragno/marketplace/artifacts";
import type { MarketplacePackagePublishRequest } from "@/fragno/marketplace/package-publishing";
import { decodeMarketplaceReleaseBytes } from "@/fragno/marketplace/release-snapshot";
import type { UploadRouteCaller } from "@/fragno/upload-server";
import { bytesToHex } from "@/lib/crypto";

import {
  createMarketplaceArtifactUpload,
  transferMarketplaceArtifactUpload,
} from "./marketplace-artifact-upload";
import {
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";

/** Granular external retry boundaries are shared by bundled and workspace package publication. */
export const MARKETPLACE_PUBLICATION_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;

/** Base64 bytes stay encoded on replay and are decoded only inside the transfer step. */
export type MarketplaceArtifactPublicationFile = {
  relativePath: string;
  fileKey: string;
  content: string;
  sizeBytes: number;
  checksum: { algo: "sha256"; value: string };
};

type MarketplaceArtifactPublication = {
  filePrefix: string;
  expectedFiles: MarketplacePackagePublishRequest["expectedFiles"];
  beforeCommit: () => Promise<void>;
};

/** Prepared uploads stay invisible until writes and obsolete-file deletions commit in one batch. */
export async function publishMarketplaceArtifactFiles({
  step,
  routes,
  files,
  publication,
}: {
  step: WorkflowStep;
  routes: UploadRouteCaller;
  files: MarketplaceArtifactPublicationFile[];
  publication: MarketplaceArtifactPublication;
}): Promise<void> {
  const preconditions = new Map(
    publication.expectedFiles.map((file) => [file.fileKey, file.precondition]),
  );
  const plan = await step.do(
    "plan marketplace artifact writes",
    MARKETPLACE_PUBLICATION_RETRIES,
    async (): Promise<{ state: "committed" } | { state: "prepare"; unchangedKeys: string[] }> => {
      const inventory = await listUploadFiles({
        routes,
        provider: "database",
        prefix: publication.filePrefix,
      });
      if (marketplaceArtifactFileInventoryMatches(files, inventory)) {
        return { state: "committed" };
      }
      const existing = new Map(inventory.map((file) => [file.fileKey, file]));
      const unchangedKeys = files
        .filter((file) => {
          const current = existing.get(file.fileKey);
          return (
            preconditions.get(file.fileKey)?.kind === "revision" &&
            current &&
            marketplaceArtifactFileInventoryMatches([file], [current])
          );
        })
        .map((file) => file.fileKey);
      return { state: "prepare", unchangedKeys };
    },
  );
  if (plan.state === "committed") {
    return;
  }

  // Persist the reuse decision, then assert every reused revision in the same atomic batch as writes/deletions.
  const unchangedKeys = new Set(plan.unchangedKeys);
  const writes: PreparedFileWrite[] = [];
  for (const file of files) {
    if (unchangedKeys.has(file.fileKey)) {
      continue;
    }
    const stepKey = bytesToHex(new TextEncoder().encode(file.fileKey));
    const session = await step.do(
      `create marketplace artifact upload ${stepKey}`,
      MARKETPLACE_PUBLICATION_RETRIES,
      async () => ({ uploadId: await createMarketplaceArtifactUpload({ routes, file }) }),
    );
    const prepared = await step.do(
      `transfer marketplace artifact upload ${stepKey}`,
      MARKETPLACE_PUBLICATION_RETRIES,
      async () =>
        transferMarketplaceArtifactUpload({
          routes,
          uploadId: session.uploadId,
          content: decodeMarketplaceReleaseBytes(file.content),
        }),
    );
    writes.push(prepared);
  }

  await step.do("commit marketplace artifact files", MARKETPLACE_PUBLICATION_RETRIES, async () => {
    // Recheck current authority and publishing ownership immediately before promotion.
    await publication.beforeCommit();
    const currentFiles = await listUploadFiles({
      routes,
      provider: "database",
      prefix: publication.filePrefix,
    });
    if (marketplaceArtifactFileInventoryMatches(files, currentFiles)) {
      return;
    }

    if (currentFiles.some((file) => !preconditions.has(file.fileKey))) {
      throw new NonRetryableError(
        "Marketplace version files changed after publication was prepared. Submit a new publication.",
      );
    }
    const entries: PreparedFileBatchEntry[] = writes.map((write) => ({
      kind: "write",
      uploadId: write.uploadId,
      precondition: preconditions.get(write.fileKey)!,
    }));
    entries.push(
      ...plan.unchangedKeys.map(
        (fileKey): PreparedFileBatchEntry => ({
          kind: "assert",
          provider: "database",
          fileKey,
          precondition: preconditions.get(fileKey)!,
        }),
      ),
    );
    const desiredKeys = new Set(files.map((file) => file.fileKey));
    for (const file of publication.expectedFiles) {
      if (!desiredKeys.has(file.fileKey) && file.precondition.kind === "revision") {
        entries.push({
          kind: "delete",
          provider: "database",
          fileKey: file.fileKey,
          precondition: file.precondition,
        });
      }
    }
    const response = await routes("POST", "/files/commit-prepared", { body: { entries } });
    if (response.type === "error") {
      if (response.error.code === "FILE_PRECONDITION_FAILED") {
        if (
          marketplaceArtifactFileInventoryMatches(
            files,
            await listUploadFiles({ routes, provider: "database", prefix: publication.filePrefix }),
          )
        ) {
          return;
        }
        throw new NonRetryableError(
          "Marketplace version files changed after publication was prepared. Submit a new publication.",
        );
      }
      throwMarketplaceUploadRouteError({
        operation: "Marketplace artifact batch commit",
        status: response.status,
        error: response.error,
      });
    }
    if (response.type !== "json" || response.status < 200 || response.status >= 300) {
      throwUnexpectedMarketplaceUploadResponse({
        operation: "Marketplace artifact batch commit",
        status: response.status,
      });
    }
  });
}
