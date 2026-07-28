import { createRouteCaller } from "@fragno-dev/core/api";
import {
  defineWorkflow,
  NonRetryableError,
  type WorkflowStep,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { UploadObject } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  createSystemFilesContext,
  createUploadFileSystem,
  emptyStaticFileArtifacts,
  UploadFileWriteConflictError,
  type UploadFileWritePrecondition,
} from "@/files";
import {
  marketplaceArtifactFilePath,
  normalizeMarketplaceArtifactPath,
} from "@/fragno/marketplace/artifacts";
import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
} from "@/fragno/marketplace/contracts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import type { UploadFragment } from "@/fragno/upload-server";
import { sha256Hex } from "@/lib/crypto";

import type { createAutomationFragment } from "./index";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  MarketplaceIngestionArtifactUnavailableError,
  MarketplaceIngestionStateConflictError,
  MarketplaceIngestionTargetAccessError,
  marketplaceIngestionTargetScopeKey,
  marketplaceIngestionWorkflowInputSchema,
  resolveMarketplaceIngestionArtifactVersion,
} from "./marketplace-ingestions";

export const MARKETPLACE_INGEST_WORKFLOW_NAME = "marketplace-ingest";
const MARKETPLACE_ARTIFACT_MOUNT_POINT = "/artifact";
const MARKETPLACE_ARTIFACT_LIST_PAGE_SIZE = 500;
const MARKETPLACE_ARTIFACT_MAX_LIST_PAGES = 5;
const TEXT_ENCODER = new TextEncoder();
const MARKETPLACE_EXTERNAL_STEP_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;

const marketplaceIngestWorkflowOutputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

const createUploadRouteCaller = (object: UploadObject) =>
  createRouteCaller<UploadFragment>({
    baseUrl: "https://upload.internal",
    mountRoute: "/api/upload",
    fetch: (request) => object.fetch(request),
  });

type UploadRouteCaller = ReturnType<typeof createUploadRouteCaller>;

const requestUploadFile = async (callRoute: UploadRouteCaller, fileKey: string) => {
  const response = await callRoute("GET", "/files/by-key", {
    query: { provider: UPLOAD_PROVIDER_DATABASE, key: fileKey },
  });
  if (response.type === "error" && response.status === 404) {
    return null;
  }
  if (response.type !== "json" || response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to read Upload metadata for '${fileKey}' (${response.status}).`);
  }
  if (response.data.status === "deleted") {
    return null;
  }
  return response.data;
};

type UploadFile = NonNullable<Awaited<ReturnType<typeof requestUploadFile>>>;

type MarketplaceIngestSourceFile = Omit<UploadFile, "checksum" | "revision"> & {
  checksum: NonNullable<UploadFile["checksum"]>;
  relativePath: string;
  mode: number | null;
};

const uploadFileMode = (file: Pick<UploadFile, "metadata">): number | null => {
  const metadata = file.metadata?.__docsFs;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const mode = (metadata as Record<string, unknown>).mode;
  return typeof mode === "number" && Number.isInteger(mode) ? mode : null;
};

const uploadFilesMatch = (
  source: MarketplaceIngestSourceFile,
  target: UploadFile | null,
): boolean =>
  target?.checksum?.algo === source.checksum.algo &&
  target.checksum.value === source.checksum.value &&
  target.sizeBytes === source.sizeBytes;

const assertMarketplaceSourceBytesMatch = async (
  source: MarketplaceIngestSourceFile,
  bytes: Uint8Array,
) => {
  if (source.checksum.algo !== "sha256") {
    throw new NonRetryableError(
      `Marketplace artifact file '${source.fileKey}' uses unsupported checksum '${source.checksum.algo}'.`,
    );
  }
  if (bytes.byteLength !== source.sizeBytes) {
    throw new NonRetryableError(
      `Marketplace artifact file '${source.fileKey}' changed size while it was being ingested.`,
    );
  }
  const checksum = await sha256Hex(bytes);
  if (checksum !== source.checksum.value.toLowerCase()) {
    throw new NonRetryableError(
      `Marketplace artifact file '${source.fileKey}' changed content while it was being ingested.`,
    );
  }
};

const listMarketplaceArtifactFiles = async (input: {
  artifactDirectory: string;
  callRoute: UploadRouteCaller;
  pageStepName: string;
  step: WorkflowStep;
}): Promise<MarketplaceIngestSourceFile[]> => {
  const artifactPrefix = `${input.artifactDirectory}/`;
  const files: MarketplaceIngestSourceFile[] = [];
  let cursor: string | undefined;
  let listingComplete = false;

  for (let pageIndex = 0; pageIndex < MARKETPLACE_ARTIFACT_MAX_LIST_PAGES; pageIndex += 1) {
    const pageCursor = cursor;
    const page = await input.step.do(
      input.pageStepName,
      MARKETPLACE_EXTERNAL_STEP_RETRIES,
      async function listPublishedMarketplaceArtifactFilePage() {
        const response = await input.callRoute("GET", "/files", {
          query: {
            provider: UPLOAD_PROVIDER_DATABASE,
            prefix: artifactPrefix,
            status: "ready",
            pageSize: String(MARKETPLACE_ARTIFACT_LIST_PAGE_SIZE),
            ...(pageCursor ? { cursor: pageCursor } : {}),
          },
        });
        if (response.type !== "json" || response.status < 200 || response.status >= 300) {
          throw new Error(`Failed to list Marketplace artifact files (${response.status}).`);
        }
        return response.data;
      },
    );

    for (const file of page.files) {
      if (file.metadata?.__docsDirectoryMarker === true) {
        continue;
      }
      const relativePath = normalizeMarketplaceArtifactPath(
        file.fileKey.slice(artifactPrefix.length),
      );
      const checksum = file.checksum;
      if (!checksum) {
        throw new NonRetryableError(`Marketplace artifact file '${file.fileKey}' has no checksum.`);
      }
      files.push({ ...file, checksum, relativePath, mode: uploadFileMode(file) });
    }

    if (!page.hasNextPage) {
      listingComplete = true;
      break;
    }
    if (!page.cursor) {
      throw new NonRetryableError(
        "Marketplace artifact listing reported another page without a cursor.",
      );
    }
    cursor = page.cursor;
  }

  if (!listingComplete) {
    throw new NonRetryableError(
      `Marketplace artifact listing exceeds ${MARKETPLACE_ARTIFACT_MAX_LIST_PAGES} pages.`,
    );
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

export const buildMarketplaceIngestionWorkflowInstanceId = async (input: {
  targetScope: BackofficeRoutableScope;
  listingId: string;
  version: string;
}) =>
  `marketplace-ingest-${await sha256Hex(
    TEXT_ENCODER.encode(
      `${marketplaceIngestionTargetScopeKey(input.targetScope)}\0${marketplaceListingIdSchema.parse(input.listingId)}\0${marketplaceVersionSchema.parse(input.version)}`,
    ),
  )}`;

type PlannedMarketplaceWrite = {
  source: MarketplaceIngestSourceFile;
  precondition: UploadFileWritePrecondition;
  applySourceMode: boolean;
};

type MarketplaceIngestWorkflowConfig = {
  ownerScope: BackofficeContextScope;
  runtime?: BackofficeRuntimeServices;
  getAutomationFragment: () => ReturnType<typeof createAutomationFragment> | undefined;
};

export const defineMarketplaceIngestWorkflow = (config: MarketplaceIngestWorkflowConfig) =>
  defineWorkflow(
    {
      name: MARKETPLACE_INGEST_WORKFLOW_NAME,
      schema: marketplaceIngestionWorkflowInputSchema,
      outputSchema: marketplaceIngestWorkflowOutputSchema,
    },
    async (event, step) => {
      const input = event.payload;
      const ownerScope = config.ownerScope;
      if (ownerScope.kind !== "org") {
        throw new NonRetryableError(
          "Marketplace ingestion workflows require an organization Automations object.",
        );
      }
      const organizationId = ownerScope.orgId;
      try {
        assertMarketplaceIngestionTargetBelongsToOrganization({
          organizationId,
          targetScope: input.targetScope,
        });
      } catch (error) {
        if (error instanceof MarketplaceIngestionTargetAccessError) {
          throw new NonRetryableError(error.message);
        }
        throw error;
      }

      const runtime = config.runtime;
      if (!runtime) {
        throw new Error("Marketplace ingestion requires Backoffice runtime services.");
      }

      await step.do(
        "validate marketplace ingestion target",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function validateMarketplaceIngestionTarget() {
          const automationFragment = config.getAutomationFragment();
          if (!automationFragment) {
            throw new Error("Marketplace ingestion requires the local Automations fragment.");
          }

          try {
            await assertMarketplaceIngestionTargetAccessible({
              organizationId,
              targetScope: input.targetScope,
              projectExists: async (projectId) =>
                Boolean(
                  await automationFragment.callServices(() =>
                    automationFragment.services.resolveProjectForExecution({ projectId }),
                  ),
                ),
              organizationHasMember: async (userId) =>
                await runtime.objects.auth.singleton().hasOrganizationMember({
                  organizationId,
                  userId,
                }),
            });
          } catch (error) {
            if (error instanceof MarketplaceIngestionTargetAccessError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );

      if (input.targetScope.kind === "org") {
        const targetOrganizationId = input.targetScope.orgId;
        await step.do(
          "prepare marketplace ingestion destination",
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async function prepareMarketplaceIngestionDestination() {
            const upload = runtime.objects.upload.forOrg(targetOrganizationId);
            const uploadConfig = await upload.getAdminConfig();
            if (!uploadConfig.providers.database?.configured) {
              await upload.setAdminConfig({ provider: "database" }, targetOrganizationId);
            }
          },
        );
      }

      const installed = await step.do(
        "resolve installed marketplace version",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function resolveInstalledMarketplaceVersion() {
          const automationFragment = config.getAutomationFragment();
          if (!automationFragment) {
            throw new Error("Marketplace ingestion requires the local Automations fragment.");
          }
          return await automationFragment.callServices(() =>
            automationFragment.services.getMarketplaceIngestion({
              targetScope: input.targetScope,
              listingId: input.listingId,
            }),
          );
        },
      );

      const artifact = await step.do(
        "resolve published marketplace artifact",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function resolvePublishedMarketplaceArtifact() {
          const manifest = await runtime.objects.marketplace.singleton().getArtifactManifest({
            listingId: input.listingId,
          });
          let resolvedArtifact;
          try {
            resolvedArtifact = resolveMarketplaceIngestionArtifactVersion(manifest, input.version);
          } catch (error) {
            if (error instanceof MarketplaceIngestionArtifactUnavailableError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
          const previous = installed
            ? resolvedArtifact.manifest.versions.find(
                (candidate) => candidate.version === installed.version,
              )
            : undefined;
          if (installed && !previous) {
            throw new NonRetryableError(
              `Installed Marketplace version '${installed.version}' is no longer available.`,
            );
          }
          return {
            listingId: resolvedArtifact.manifest.listingId,
            version: resolvedArtifact.version.version,
            artifactDirectory: resolvedArtifact.version.directory,
            previousArtifactDirectory:
              previous && previous.version !== resolvedArtifact.version.version
                ? previous.directory
                : null,
            uploadName: resolvedArtifact.manifest.uploadName,
          };
        },
      );

      const sourceObject = runtime.objects.upload.forName(artifact.uploadName);
      const sourceUploadRoutes = createUploadRouteCaller(sourceObject);
      const sourceFiles = await listMarketplaceArtifactFiles({
        artifactDirectory: artifact.artifactDirectory,
        callRoute: sourceUploadRoutes,
        pageStepName: "list marketplace artifact files page",
        step,
      });
      if (sourceFiles.length === 0) {
        throw new NonRetryableError("Marketplace artifact contains no files.");
      }

      const previousSourceFiles = artifact.previousArtifactDirectory
        ? await listMarketplaceArtifactFiles({
            artifactDirectory: artifact.previousArtifactDirectory,
            callRoute: sourceUploadRoutes,
            pageStepName: "list installed marketplace artifact files page",
            step,
          })
        : [];
      const previousSourceFilesByPath = new Map(
        previousSourceFiles.map((source) => [source.relativePath, source]),
      );

      const destinationObject = runtime.objects.upload.for(input.targetScope);
      const destinationUploadRoutes = createUploadRouteCaller(destinationObject);
      const writes = await step.do(
        "plan marketplace workspace writes",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function planMarketplaceWorkspaceWrites() {
          const planned: PlannedMarketplaceWrite[] = [];
          for (const source of sourceFiles) {
            const target = await requestUploadFile(destinationUploadRoutes, source.relativePath);
            if (!target) {
              planned.push({
                source,
                precondition: { kind: "absent" },
                applySourceMode: true,
              });
              continue;
            }
            if (uploadFilesMatch(source, target)) {
              continue;
            }

            const installedSource = previousSourceFilesByPath.get(source.relativePath);
            if (installedSource && uploadFilesMatch(installedSource, target)) {
              planned.push({
                source,
                precondition: { kind: "revision", revision: target.revision },
                applySourceMode: false,
              });
              continue;
            }

            throw new NonRetryableError(
              `Marketplace ingestion conflicts with existing workspace file '/workspace/${source.relativePath}'.`,
            );
          }
          return planned;
        },
      );

      const execution: BackofficeExecutionContext = {
        actor: {
          type: "automation",
          id: `marketplace-ingest:${artifact.listingId}@${artifact.version}`,
          organizationIds: [organizationId],
        },
        scope: input.targetScope,
      };
      const targetFileSystem = createUploadFileSystem(
        createSystemFilesContext({
          objects: runtime.objects,
          execution,
          staticFileArtifacts: emptyStaticFileArtifacts,
        }),
        {
          object: destinationObject,
          provider: UPLOAD_PROVIDER_DATABASE,
          mountPoint: "/workspace",
        },
      );
      const sourceFileSystem = createUploadFileSystem(
        createSystemFilesContext({
          objects: runtime.objects,
          execution: {
            actor: { type: "system", id: "marketplace-ingest" },
            scope: { kind: "system" },
          },
          staticFileArtifacts: emptyStaticFileArtifacts,
        }),
        {
          object: sourceObject,
          provider: UPLOAD_PROVIDER_DATABASE,
          mountPoint: MARKETPLACE_ARTIFACT_MOUNT_POINT,
        },
      );

      for (const write of writes) {
        const { source } = write;
        await step.do(
          `copy marketplace artifact ${await sha256Hex(TEXT_ENCODER.encode(source.relativePath))}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async function copyMarketplaceArtifactFile() {
            const sourcePath = `${MARKETPLACE_ARTIFACT_MOUNT_POINT}/${marketplaceArtifactFilePath(
              artifact.artifactDirectory,
              source.relativePath,
            )}`;
            const targetPath = `/workspace/${source.relativePath}`;
            const sourceBytes = await sourceFileSystem.readFileBuffer(sourcePath);
            await assertMarketplaceSourceBytesMatch(source, sourceBytes);

            try {
              await targetFileSystem.writeFileConditional(targetPath, sourceBytes, {
                contentType: source.contentType,
                precondition: write.precondition,
              });
            } catch (error) {
              if (!(error instanceof UploadFileWriteConflictError)) {
                throw error;
              }
              const target = await requestUploadFile(destinationUploadRoutes, source.relativePath);
              if (!uploadFilesMatch(source, target)) {
                throw new NonRetryableError(
                  `Marketplace ingestion conflicts with concurrently changed workspace file '${targetPath}'.`,
                );
              }
            }

            if (write.applySourceMode && source.mode !== null) {
              await targetFileSystem.chmod(targetPath, source.mode);
            }
          },
        );
      }

      await step.do(
        "verify marketplace workspace files",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function verifyMarketplaceWorkspaceFiles() {
          for (const source of sourceFiles) {
            const target = await requestUploadFile(destinationUploadRoutes, source.relativePath);
            if (!uploadFilesMatch(source, target)) {
              throw new NonRetryableError(
                `Marketplace ingestion verification failed for '/workspace/${source.relativePath}'.`,
              );
            }
          }
        },
      );

      await step.do(
        "record successful marketplace ingestion",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function recordSuccessfulMarketplaceIngestion() {
          const automationFragment = config.getAutomationFragment();
          if (!automationFragment) {
            throw new Error("Marketplace ingestion requires the local Automations fragment.");
          }
          try {
            await automationFragment.callServices(() =>
              automationFragment.services.upsertMarketplaceIngestion({
                targetScope: input.targetScope,
                listingId: artifact.listingId,
                version: artifact.version,
                expectedVersion: installed?.version ?? null,
              }),
            );
          } catch (error) {
            if (error instanceof MarketplaceIngestionStateConflictError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );

      return {
        listingId: artifact.listingId,
        version: artifact.version,
        workflowInstanceId: event.instanceId,
      };
    },
  );
