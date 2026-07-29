import { createRouteCaller } from "@fragno-dev/core/api";
import type { PreparedFileWrite, UploadFileWritePrecondition } from "@fragno-dev/upload/types";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  marketplaceArtifactFilePath,
  marketplaceArtifactUploadName,
  prepareMarketplaceArtifactFiles,
} from "@/fragno/marketplace/artifacts";
import {
  marketplaceListingIdSchema,
  marketplaceSlugSchema,
  marketplaceVersionSchema,
  type MarketplaceDraftResult,
} from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import type { UploadFragment } from "@/fragno/upload-server";
import { bytesToHex, sha256Hex } from "@/lib/crypto";

import {
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";

export const MARKETPLACE_PUBLISH_WORKFLOW_NAME = "marketplace-publish";
const TEXT_ENCODER = new TextEncoder();
const MARKETPLACE_UPLOAD_ORIGIN = "https://marketplace-upload.internal";
const MARKETPLACE_EXTERNAL_STEP_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;
const MARKETPLACE_ARTIFACT_FILE_METADATA = {
  __docsFs: {
    owner: { kind: "root" },
    group: { kind: "root" },
    mode: 0o664,
  },
} as const;

type PreparedMarketplaceArtifactWrite = PreparedFileWrite & {
  precondition: UploadFileWritePrecondition;
};

const inferMarketplaceArtifactContentType = (fileKey: string): string => {
  if (/\.json$/iu.test(fileKey)) {
    return "application/json";
  }
  if (/\.(md|mdx)$/iu.test(fileKey)) {
    return "text/markdown";
  }
  if (/\.(txt|log)$/iu.test(fileKey)) {
    return "text/plain";
  }
  if (/\.(ts|tsx)$/iu.test(fileKey)) {
    return "text/typescript";
  }
  if (/\.js$/iu.test(fileKey)) {
    return "text/javascript";
  }
  if (/\.html?$/iu.test(fileKey)) {
    return "text/html";
  }
  if (/\.css$/iu.test(fileKey)) {
    return "text/css";
  }
  if (/\.ya?ml$/iu.test(fileKey)) {
    return "application/yaml";
  }
  if (/\.sh$/iu.test(fileKey)) {
    return "text/x-shellscript";
  }

  return "application/octet-stream";
};

const marketplacePublishWorkflowParamsSchema = z.object({
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
});

const marketplacePublishWorkflowOutputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

export type MarketplacePublishWorkflowParams = z.infer<
  typeof marketplacePublishWorkflowParamsSchema
>;

export const buildMarketplacePublicationWorkflowInstanceId = (input: {
  listingId: string;
  version: string;
}) =>
  `marketplace-publish-${bytesToHex(TEXT_ENCODER.encode(`${input.listingId}\0${input.version}`))}`;

type MarketplacePublishWorkflowConfig = {
  ownerScope: BackofficeContextScope;
  runtime?: BackofficeRuntimeServices;
};

export const defineMarketplacePublishWorkflow = (config: MarketplacePublishWorkflowConfig) =>
  defineWorkflow(
    {
      name: MARKETPLACE_PUBLISH_WORKFLOW_NAME,
      schema: marketplacePublishWorkflowParamsSchema,
      outputSchema: marketplacePublishWorkflowOutputSchema,
    },
    async (event, step) => {
      if (config.ownerScope.kind !== "org") {
        throw new NonRetryableError(
          "Marketplace publication workflows require an organization Automations object.",
        );
      }
      const runtime = config.runtime;
      if (!runtime) {
        throw new Error("Marketplace publication workflows require Backoffice runtime services.");
      }

      const marketplace = runtime.objects.marketplace.singleton();
      const createArtifactUploadRouteCaller = (uploadName: string) => {
        const uploadObject = runtime.objects.upload.forName(uploadName);
        return createRouteCaller<UploadFragment>({
          baseUrl: MARKETPLACE_UPLOAD_ORIGIN,
          mountRoute: "/api/upload",
          fetch: (request) => uploadObject.fetch(request),
        });
      };

      const snapshot = await step.do("snapshot static marketplace entry", async () => {
        const entry = getStaticMarketplaceEntry(event.payload);
        if (!entry) {
          throw new NonRetryableError(
            `Static marketplace entry ${event.payload.slug}@${event.payload.version} was not found.`,
          );
        }

        const listingId = marketplaceListingId({
          ownerScope: entry.owner.scope,
          slug: entry.slug,
        });
        const artifactDirectory = marketplaceVersionSchema.parse(entry.version);
        const files = [];
        for (const file of prepareMarketplaceArtifactFiles(entry.files)) {
          const content = TEXT_ENCODER.encode(file.content);
          const fileKey = marketplaceArtifactFilePath(artifactDirectory, file.relativePath);
          files.push({
            relativePath: file.relativePath,
            content: file.content,
            fileKey,
            filename: file.relativePath.split("/").at(-1) ?? file.relativePath,
            contentType: inferMarketplaceArtifactContentType(fileKey),
            sizeBytes: content.byteLength,
            checksum: {
              algo: "sha256" as const,
              value: await sha256Hex(content),
            },
            stepKey: bytesToHex(TEXT_ENCODER.encode(file.relativePath)),
          });
        }

        return {
          entry,
          listingId,
          artifactDirectory,
          artifactUploadName: marketplaceArtifactUploadName(listingId),
          files,
        };
      });
      const { entry, listingId, artifactDirectory, files } = snapshot;
      const callUploadRoute = createArtifactUploadRouteCaller(snapshot.artifactUploadName);

      const createdDraft = await step.do(
        "create marketplace draft listing",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async (): Promise<MarketplaceDraftResult | null> => {
          const result = await marketplace.createDraftListing(entry);
          if (result.ok) {
            return result.value;
          }
          if (result.error.code === "MARKETPLACE_LISTING_CONFLICT") {
            return null;
          }
          throw new NonRetryableError(`${result.error.code}: ${result.error.message}`);
        },
      );
      const draft =
        createdDraft ??
        (await step.do(
          "add marketplace draft version",
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async (): Promise<MarketplaceDraftResult> => {
            const result = await marketplace.addDraftVersion({
              owner: entry.owner,
              listingId,
              version: entry.version,
            });
            if (!result.ok) {
              throw new NonRetryableError(`${result.error.code}: ${result.error.message}`);
            }
            return result.value;
          },
        ));
      const preparedWrites: PreparedMarketplaceArtifactWrite[] = [];

      for (const file of files) {
        const uploadSession = await step.do(
          `create marketplace artifact upload ${file.stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async function createMarketplaceArtifactUpload() {
            const response = await callUploadRoute("POST", "/uploads", {
              body: {
                provider: UPLOAD_PROVIDER_DATABASE,
                fileKey: file.fileKey,
                filename: file.filename,
                sizeBytes: file.sizeBytes,
                contentType: file.contentType,
                checksum: file.checksum,
                metadata: MARKETPLACE_ARTIFACT_FILE_METADATA,
                publicationMode: "batch",
              },
            });
            if (response.type === "error") {
              return throwMarketplaceUploadRouteError({
                operation: "Marketplace artifact upload creation",
                status: response.status,
                error: response.error,
              });
            }
            if (response.type !== "json") {
              return throwUnexpectedMarketplaceUploadResponse({
                operation: "Marketplace artifact upload creation",
                status: response.status,
              });
            }
            if (response.status < 200 || response.status >= 300) {
              return throwUnexpectedMarketplaceUploadResponse({
                operation: "Marketplace artifact upload creation",
                status: response.status,
              });
            }
            return { uploadId: response.data.uploadId };
          },
        );

        const prepared = await step.do(
          `transfer marketplace artifact upload ${file.stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async function transferMarketplaceArtifactUpload() {
            const content = TEXT_ENCODER.encode(file.content);
            const response = await callUploadRoute("PUT", "/uploads/:uploadId/content", {
              pathParams: { uploadId: uploadSession.uploadId },
              query: { provider: UPLOAD_PROVIDER_DATABASE },
              headers: { "content-type": "application/octet-stream" },
              body: new Blob([Uint8Array.from(content)]),
            });
            if (response.type === "error") {
              return throwMarketplaceUploadRouteError({
                operation: "Marketplace artifact upload transfer",
                status: response.status,
                error: response.error,
              });
            }
            if (response.type !== "json") {
              return throwUnexpectedMarketplaceUploadResponse({
                operation: "Marketplace artifact upload transfer",
                status: response.status,
              });
            }
            if (response.status < 200 || response.status >= 300) {
              return throwUnexpectedMarketplaceUploadResponse({
                operation: "Marketplace artifact upload transfer",
                status: response.status,
              });
            }
            if (response.data.kind !== "prepared") {
              throw new NonRetryableError(
                "Marketplace batch upload published before its atomic commit.",
              );
            }
            return {
              ...response.data.write,
              precondition: { kind: "absent" as const },
            };
          },
        );
        preparedWrites.push(prepared);
      }

      await step.do(
        "commit marketplace artifact files",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async () => {
          const response = await callUploadRoute("POST", "/files/commit-prepared", {
            body: {
              entries: preparedWrites.map((write) => ({
                kind: "write" as const,
                uploadId: write.uploadId,
                precondition: write.precondition,
              })),
            },
          });
          if (response.type === "error") {
            return throwMarketplaceUploadRouteError({
              operation: "Marketplace artifact batch commit",
              status: response.status,
              error: response.error,
            });
          }
          if (response.type !== "json") {
            return throwUnexpectedMarketplaceUploadResponse({
              operation: "Marketplace artifact batch commit",
              status: response.status,
            });
          }
          if (response.status < 200 || response.status >= 300) {
            return throwUnexpectedMarketplaceUploadResponse({
              operation: "Marketplace artifact batch commit",
              status: response.status,
            });
          }
          return response.data;
        },
      );

      await step.do(
        "publish marketplace artifact version",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async () => {
          const manifest = await marketplace.getArtifactManifest({ listingId: draft.listingId });
          const existingVersion = manifest?.versions.find(
            (candidate) => candidate.version === entry.version,
          );
          if (existingVersion) {
            if (existingVersion.directory !== artifactDirectory) {
              throw new NonRetryableError(
                `Marketplace version '${entry.version}' is already published with a different artifact directory.`,
              );
            }
            return { published: false } as const;
          }

          const publishedVersion = await marketplace.publishVersion({
            owner: entry.owner,
            listingId: draft.listingId,
            version: entry.version,
            artifactDirectory,
          });
          if (!publishedVersion.ok) {
            throw new NonRetryableError(
              `${publishedVersion.error.code}: ${publishedVersion.error.message}`,
            );
          }
          return publishedVersion.value;
        },
      );

      return {
        listingId: draft.listingId,
        slug: entry.slug,
        version: entry.version,
        workflowInstanceId: event.instanceId,
      };
    },
  );
