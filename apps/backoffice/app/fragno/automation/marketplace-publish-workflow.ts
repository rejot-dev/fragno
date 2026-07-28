import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createUploadFileSystem,
  createSystemFilesContext,
  emptyStaticFileArtifacts,
} from "@/files";
import {
  marketplaceArtifactDirectory,
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
import { bytesToHex } from "@/lib/crypto";

export const MARKETPLACE_PUBLISH_WORKFLOW_NAME = "marketplace-publish";
const MARKETPLACE_ARTIFACT_MOUNT_POINT = "/artifact";
const TEXT_ENCODER = new TextEncoder();
const MARKETPLACE_EXTERNAL_STEP_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;

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
      const orgId = config.ownerScope.orgId;

      const entry = await step.do(
        "snapshot static marketplace entry",
        async function snapshotStaticMarketplaceEntry() {
          const selected = getStaticMarketplaceEntry(event.payload);
          if (!selected) {
            throw new NonRetryableError(
              `Static marketplace entry ${event.payload.slug}@${event.payload.version} was not found.`,
            );
          }
          return selected;
        },
      );

      const draft = await step.do(
        "reserve marketplace listing version",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function reserveMarketplaceListingVersion(): Promise<MarketplaceDraftResult> {
          const marketplace = runtime.objects.marketplace.singleton();
          const createdDraft = await marketplace.createDraftListing(entry);
          if (createdDraft.ok) {
            return createdDraft.value;
          }
          if (createdDraft.error.code !== "MARKETPLACE_LISTING_CONFLICT") {
            throw new NonRetryableError(
              `${createdDraft.error.code}: ${createdDraft.error.message}`,
            );
          }

          const listingId = marketplaceListingId({
            ownerScope: entry.owner.scope,
            slug: entry.slug,
          });
          const addedDraft = await marketplace.addDraftVersion({
            owner: entry.owner,
            listingId,
            version: entry.version,
          });
          if (!addedDraft.ok) {
            throw new NonRetryableError(`${addedDraft.error.code}: ${addedDraft.error.message}`);
          }
          return addedDraft.value;
        },
      );

      await step.do(
        "write marketplace artifact",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function writeMarketplaceArtifactFiles() {
          const uploadObject = runtime.objects.upload.forName(
            marketplaceArtifactUploadName(draft.listingId),
          );
          const fileSystemContext = createSystemFilesContext({
            objects: runtime.objects,
            execution: {
              actor: {
                type: "automation",
                id: `marketplace-publish:${entry.slug}@${entry.version}`,
                organizationIds: [orgId],
              },
              scope: { kind: "org", orgId },
            },
            staticFileArtifacts: emptyStaticFileArtifacts,
          });
          const artifactFileSystem = createUploadFileSystem(fileSystemContext, {
            object: uploadObject,
            provider: UPLOAD_PROVIDER_DATABASE,
            mountPoint: MARKETPLACE_ARTIFACT_MOUNT_POINT,
          });
          const artifactDirectory = marketplaceArtifactDirectory(entry.version);
          const files = prepareMarketplaceArtifactFiles(entry.files);

          for (const file of files) {
            const fileKey = marketplaceArtifactFilePath(artifactDirectory, file.relativePath);
            await artifactFileSystem.writeFile(
              `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/${fileKey}`,
              file.content,
            );
          }
        },
      );

      await step.do(
        "publish marketplace artifact version",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function publishMarketplaceArtifactVersion() {
          const marketplace = runtime.objects.marketplace.singleton();
          const artifactDirectory = marketplaceArtifactDirectory(entry.version);
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
