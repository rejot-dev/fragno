import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import {
  createBackofficeSystemExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { isBackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { marketplaceArtifactUploadName } from "@/fragno/marketplace/artifacts";
import {
  marketplaceListingIdSchema,
  marketplaceSlugSchema,
  marketplaceVersionSchema,
} from "@/fragno/marketplace/contracts";
import {
  marketplacePackagePublishRequestSchema,
  marketplacePackagePublishWorkflowInstanceId,
} from "@/fragno/marketplace/package-publishing";
import {
  marketplaceReleaseArtifactFiles,
  verifyMarketplaceReleaseSnapshot,
} from "@/fragno/marketplace/release-snapshot";
import { createUploadRouteCaller } from "@/fragno/upload-server";

import {
  backofficeWorkflowActorMetadataSchema,
  BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY,
} from "./actors";
import {
  MARKETPLACE_PUBLICATION_RETRIES,
  publishMarketplaceArtifactFiles,
} from "./marketplace-artifact-publication";

/** All captured releases use the same System publication workflow, regardless of source. */
export const MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME = "marketplace-package-publish";
const marketplacePackagePublishWorkflowParamsSchema = z.strictObject({
  request: marketplacePackagePublishRequestSchema,
  metadata: backofficeWorkflowActorMetadataSchema,
});
const marketplacePackagePublishWorkflowOutputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  slug: marketplaceSlugSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});
/** Workflow input contains captured release bytes, never a reference to mutable source definitions. */
export type MarketplacePackagePublishWorkflowParams = z.infer<
  typeof marketplacePackagePublishWorkflowParamsSchema
>;

function throwMarketplacePackagePublishError(error: unknown): never {
  if (
    (isBackofficeForbiddenError(error) && error.reason !== "authority-unavailable") ||
    (error instanceof Error &&
      [
        "MarketplacePublicationConflictError",
        "MarketplaceVersionTransitionError",
        "MarketplaceListingArchivedError",
        "MarketplacePublicationAccessError",
      ].includes(error.name))
  ) {
    throw new NonRetryableError(error.message);
  }
  throw error;
}

type MarketplacePackagePublishWorkflowConfig = {
  ownerScope: BackofficeContextScope;
  runtime?: BackofficeRuntimeServices;
};

/** Release publication runs in System while retaining the original publisher's authority. */
export function defineMarketplacePackagePublishWorkflow(
  config: MarketplacePackagePublishWorkflowConfig,
) {
  return defineWorkflow(
    {
      name: MARKETPLACE_PACKAGE_PUBLISH_WORKFLOW_NAME,
      schema: marketplacePackagePublishWorkflowParamsSchema,
      outputSchema: marketplacePackagePublishWorkflowOutputSchema,
      checkpoint: "step",
    },
    async (event, step) => {
      if (config.ownerScope.kind !== "system") {
        throw new NonRetryableError(
          "Marketplace publication workflows require the System Automations object.",
        );
      }
      const runtime = config.runtime;
      if (!runtime) {
        throw new Error("Marketplace publication workflows require Backoffice runtime services.");
      }
      const { request } = event.payload;
      if (request.workflowInstanceId !== event.instanceId) {
        throw new NonRetryableError(
          "Marketplace publishing request does not match its workflow instance.",
        );
      }
      // Generic workflow creation stamps trusted caller actors; request fields cannot impersonate them.
      if (
        JSON.stringify(request.intent.execution.actors) !==
        JSON.stringify(event.payload.metadata[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY])
      ) {
        throw new NonRetryableError(
          "Marketplace publishing actors do not match trusted workflow provenance.",
        );
      }
      await step.do("validate captured marketplace release", async () => {
        const { workflowInstanceId, ...work } = request;
        if (workflowInstanceId !== (await marketplacePackagePublishWorkflowInstanceId(work))) {
          throw new NonRetryableError(
            "Marketplace publishing workflow identity does not match its captured request.",
          );
        }
        try {
          await verifyMarketplaceReleaseSnapshot(request.intent.release);
        } catch (error) {
          throw new NonRetryableError(
            error instanceof Error
              ? error.message
              : "Marketplace captured release validation failed.",
          );
        }
      });
      const marketplace = runtime.objects.marketplace.singleton().commands;
      const context = {
        execution: createBackofficeSystemExecution({ kind: "system" }),
        propagationContext: null,
      };
      const beginPublication = async () => {
        try {
          return await marketplace.beginPackagePublish(request, context);
        } catch (error) {
          return throwMarketplacePackagePublishError(error);
        }
      };
      const publicationState = await step.do(
        "begin marketplace package publication",
        MARKETPLACE_PUBLICATION_RETRIES,
        beginPublication,
      );
      const { release } = request.intent;
      const result = {
        listingId: release.listingId,
        slug: release.slug,
        version: release.version,
        workflowInstanceId: event.instanceId,
      };
      if (publicationState === "published") {
        return result;
      }
      const filePrefix = `${release.version}/`;
      const files = await marketplaceReleaseArtifactFiles(release);
      await publishMarketplaceArtifactFiles({
        step,
        routes: createUploadRouteCaller(
          runtime.objects.upload.forName(marketplaceArtifactUploadName(release.listingId)).http,
        ),
        publication: {
          filePrefix,
          expectedFiles: request.expectedFiles,
          beforeCommit: async () => {
            await beginPublication();
          },
        },
        files: files.map((file) => ({
          relativePath: file.relativePath,
          fileKey: `${filePrefix}${file.relativePath}`,
          content: file.content,
          sizeBytes: file.sizeBytes,
          checksum: { algo: "sha256" as const, value: file.checksum },
        })),
      });
      await step.do(
        "publish marketplace package release",
        MARKETPLACE_PUBLICATION_RETRIES,
        async () => {
          try {
            await marketplace.completePackagePublish(request, context);
          } catch (error) {
            throwMarketplacePackagePublishError(error);
          }
        },
      );
      return result;
    },
  );
}
