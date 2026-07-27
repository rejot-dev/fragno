import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";

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
import type { MarketplaceDraftResult } from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import { bytesToHex } from "@/lib/crypto";

export const MARKETPLACE_PUBLISH_WORKFLOW_NAME = "marketplace-publish";
const MARKETPLACE_ARTIFACT_MOUNT_POINT = "/artifact";
const TEXT_ENCODER = new TextEncoder();

export type MarketplacePublishWorkflowParams = {
  slug: string;
  version: string;
};

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
    { name: MARKETPLACE_PUBLISH_WORKFLOW_NAME },
    async (event: { payload: MarketplacePublishWorkflowParams; instanceId: string }, step) => {
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

      const entry = getStaticMarketplaceEntry(event.payload);
      if (!entry) {
        throw new NonRetryableError(
          `Static marketplace entry ${event.payload.slug}@${event.payload.version} was not found.`,
        );
      }

      const draft = await step.do(
        "reserve marketplace listing version",
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

      await step.do("write marketplace artifact", async function writeMarketplaceArtifactFiles() {
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
      });

      await step.do(
        "publish marketplace artifact version",
        async function publishMarketplaceArtifactVersion() {
          const publishedVersion = await runtime.objects.marketplace.singleton().publishVersion({
            owner: entry.owner,
            listingId: draft.listingId,
            version: entry.version,
            artifactDirectory: marketplaceArtifactDirectory(entry.version),
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
