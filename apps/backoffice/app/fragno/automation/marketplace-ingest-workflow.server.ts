import { createRouteCaller } from "@fragno-dev/core/api";
import {
  defineWorkflow,
  NonRetryableError,
  WorkflowInstanceNotFoundError,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeContextScope,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeObjectHandle, UploadObject } from "@/backoffice-runtime/object-registry";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import {
  createSystemFilesContext,
  createUploadFileSystem,
  emptyStaticFileArtifacts,
} from "@/files";
import {
  UploadFileSystemRequestError,
  UploadFileWriteConflictError,
  type PreparedUploadFileWrite,
} from "@/files/contributors/upload";
import {
  isMarketplaceInternalArtifactPath,
  MARKETPLACE_INSTALL_WORKFLOW_PATH,
  normalizeMarketplaceArtifactPath,
} from "@/fragno/marketplace/artifacts";
import {
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
} from "@/fragno/marketplace/contracts";
import { UPLOAD_PROVIDER_DATABASE } from "@/fragno/upload";
import type { UploadFragment } from "@/fragno/upload-server";
import { sha256Hex } from "@/lib/crypto";

import { appendAutomationDelegate } from "./authority";
import type { AutomationFileSystemConfig } from "./catalog";
import {
  CODEMODE_CAPABILITY_ACTOR,
  CODEMODE_WORKFLOW,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import type { createAutomationFragment } from "./index";
import {
  MARKETPLACE_INGEST_WORKFLOW_NAME,
  marketplaceInstallationWorkflowInstanceId,
} from "./marketplace-ingest-identity";
import {
  marketplaceFileContentsMatch,
  MarketplaceWorkspaceFileConflictError,
  planMarketplaceWorkspaceUpdate,
  type MarketplaceIngestionSourceFile,
  type MarketplaceWorkspaceFileObservation,
} from "./marketplace-ingestion-files";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  MarketplaceIngestionArtifactUnavailableError,
  MarketplaceIngestionStateConflictError,
  MarketplaceIngestionTargetAccessError,
  marketplaceIngestionWorkflowInputSchema,
  resolveMarketplaceIngestionArtifactVersion,
} from "./marketplace-ingestions";
import {
  throwMarketplaceUploadRequestError,
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";
import {
  workflowCompletedEventType,
  type WorkflowCompletedEventPayload,
  withWorkflowCompletionTarget,
} from "./workflow-completion";

const MARKETPLACE_ARTIFACT_LIST_PAGE_SIZE = 500;
const MARKETPLACE_ARTIFACT_MAX_LIST_PAGES = 5;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MARKETPLACE_EXTERNAL_STEP_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;

const marketplaceIngestWorkflowOutputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

const UPLOAD_INTERNAL_ORIGIN = "https://upload.internal";

type UploadHttpTransport = Pick<BackofficeObjectHandle<UploadObject>["http"], "fetch">;

const createUploadRouteCaller = (http: UploadHttpTransport) =>
  createRouteCaller<UploadFragment>({
    baseUrl: UPLOAD_INTERNAL_ORIGIN,
    mountRoute: "/api/upload",
    fetch: (request) => http.fetch(request),
  });

type UploadRouteCaller = ReturnType<typeof createUploadRouteCaller>;

const requestMarketplaceArtifactBytes = async (http: UploadHttpTransport, fileKey: string) => {
  const url = new URL("/api/upload/files/by-key/content", UPLOAD_INTERNAL_ORIGIN);
  url.searchParams.set("provider", UPLOAD_PROVIDER_DATABASE);
  url.searchParams.set("key", fileKey);
  const response = await http.fetch(new Request(url));
  if (!response.ok) {
    let code: string | null = null;
    let message = "Upload returned an unexpected response.";
    try {
      const error = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof error.code === "string" && error.code.trim()) {
        code = error.code;
      }
      if (typeof error.message === "string" && error.message.trim()) {
        message = error.message;
      }
    } catch {
      // The HTTP status still provides a stable failure classification.
    }
    return throwMarketplaceUploadRequestError({
      operation: "Marketplace artifact content read",
      status: response.status,
      code,
      message,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
};

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

const uploadFileMode = (file: Pick<UploadFile, "metadata">): number | null => {
  const metadata = file.metadata?.__docsFs;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const mode = (metadata as Record<string, unknown>).mode;
  return typeof mode === "number" && Number.isInteger(mode) ? mode : null;
};

const throwMarketplaceUploadFileSystemError = (input: {
  operation: string;
  error: unknown;
}): never => {
  if (input.error instanceof UploadFileSystemRequestError) {
    return throwMarketplaceUploadRequestError({
      operation: input.operation,
      status: input.error.status,
      code: input.error.code,
      message: input.error.message,
    });
  }
  throw input.error;
};

const assertMarketplaceSourceBytesMatch = async (
  source: MarketplaceIngestionSourceFile,
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

type MarketplaceWorkflowsFragment = Pick<
  ReturnType<typeof createWorkflowsFragment<BackofficeExecutionContext>>,
  "callServices" | "services"
>;

type MarketplaceIngestWorkflowConfig = AutomationFileSystemConfig & {
  ownerScope: BackofficeContextScope;
  env?: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  getAutomationFragment: () => ReturnType<typeof createAutomationFragment> | undefined;
  getWorkflowsFragment: () => MarketplaceWorkflowsFragment | undefined;
};

type MarketplaceInstallationWorkflowInput = {
  listingId: string;
  version: string;
  previousVersion: string | null;
  targetScope: BackofficeRoutableScope;
  installationRoot: "/workspace";
  installedFiles: Record<string, string>;
  previousInstalledFiles: Record<string, string>;
};

const marketplaceInstalledFiles = (files: MarketplaceIngestionSourceFile[]) =>
  Object.fromEntries(files.map((file) => [file.relativePath, `/workspace/${file.relativePath}`]));

export const defineMarketplaceIngestWorkflow = (config: MarketplaceIngestWorkflowConfig) =>
  defineWorkflow(
    {
      name: MARKETPLACE_INGEST_WORKFLOW_NAME,
      schema: marketplaceIngestionWorkflowInputSchema,
      outputSchema: marketplaceIngestWorkflowOutputSchema,
      checkpoint: "step",
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
                await runtime.objects.auth.singleton().commands.hasOrganizationMember({
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
            const uploadConfig = await upload.commands.getAdminConfig();
            if (!uploadConfig.providers.database?.configured) {
              await upload.commands.setAdminConfig({ provider: "database" }, targetOrganizationId);
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
          const manifest = await runtime.objects.marketplace
            .singleton()
            .commands.getArtifactManifest({
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
                (candidate) => candidate === installed.version,
              )
            : undefined;
          if (installed && !previous) {
            throw new NonRetryableError(
              `Installed Marketplace version '${installed.version}' is no longer available.`,
            );
          }
          return {
            listingId: resolvedArtifact.manifest.listingId,
            version: resolvedArtifact.version,
            previousVersion: previous && previous !== resolvedArtifact.version ? previous : null,
            uploadName: resolvedArtifact.manifest.uploadName,
          };
        },
      );

      const sourceObject = runtime.objects.upload.forName(artifact.uploadName);
      const sourceUploadRoutes = createUploadRouteCaller(sourceObject.http);
      const artifactListings: Array<{
        kind: "requested" | "installed";
        version: string;
        pageStepName:
          | "list marketplace artifact files page"
          | "list installed marketplace artifact files page";
      }> = [
        {
          kind: "requested",
          version: artifact.version,
          pageStepName: "list marketplace artifact files page",
        },
      ];
      if (artifact.previousVersion) {
        artifactListings.push({
          kind: "installed",
          version: artifact.previousVersion,
          pageStepName: "list installed marketplace artifact files page",
        });
      }

      const artifactFiles: Record<"requested" | "installed", MarketplaceIngestionSourceFile[]> = {
        requested: [],
        installed: [],
      };
      for (const listing of artifactListings) {
        const artifactPrefix = `${listing.version}/`;
        const files: MarketplaceIngestionSourceFile[] = [];
        let cursor: string | undefined;
        let listingComplete = false;

        for (let pageIndex = 0; pageIndex < MARKETPLACE_ARTIFACT_MAX_LIST_PAGES; pageIndex += 1) {
          const pageCursor = cursor;
          const page = await step.do(
            listing.pageStepName,
            MARKETPLACE_EXTERNAL_STEP_RETRIES,
            async () => {
              const response = await sourceUploadRoutes("GET", "/files", {
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

              const pageFiles: MarketplaceIngestionSourceFile[] = [];
              for (const file of response.data.files) {
                if (file.metadata?.__docsDirectoryMarker === true) {
                  continue;
                }
                const relativePath = normalizeMarketplaceArtifactPath(
                  file.fileKey.slice(artifactPrefix.length),
                );
                const checksum = file.checksum;
                if (!checksum) {
                  throw new NonRetryableError(
                    `Marketplace artifact file '${file.fileKey}' has no checksum.`,
                  );
                }
                pageFiles.push({
                  fileKey: file.fileKey,
                  relativePath,
                  contentType: file.contentType,
                  sizeBytes: file.sizeBytes,
                  checksum,
                  mode: uploadFileMode(file),
                });
              }

              return {
                files: pageFiles,
                cursor: response.data.cursor,
                hasNextPage: response.data.hasNextPage,
              };
            },
          );
          files.push(...page.files);

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
        artifactFiles[listing.kind] = files.sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath),
        );
      }

      const requestedArtifactFiles = artifactFiles.requested;
      if (requestedArtifactFiles.length === 0) {
        throw new NonRetryableError("Marketplace artifact contains no files.");
      }
      const installationWorkflowFile = requestedArtifactFiles.find(
        (file) => file.relativePath === MARKETPLACE_INSTALL_WORKFLOW_PATH,
      );
      const sourceFiles = requestedArtifactFiles.filter(
        (file) => !isMarketplaceInternalArtifactPath(file.relativePath),
      );
      const previousSourceFiles = artifactFiles.installed.filter(
        (file) => !isMarketplaceInternalArtifactPath(file.relativePath),
      );
      const requestedSourceFilesByPath = new Map(
        sourceFiles.map((source) => [source.relativePath, source]),
      );
      const previousSourceFilesByPath = new Map(
        previousSourceFiles.map((source) => [source.relativePath, source]),
      );
      const observedRelativePaths = Array.from(
        new Set([...requestedSourceFilesByPath.keys(), ...previousSourceFilesByPath.keys()]),
      ).sort((left, right) => left.localeCompare(right));

      const destinationObject = runtime.objects.upload.for(input.targetScope);
      const destinationUploadRoutes = createUploadRouteCaller(destinationObject.http);
      const workspaceUpdate = await step.do(
        "plan marketplace workspace writes",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function planMarketplaceWorkspaceWrites() {
          const observations: MarketplaceWorkspaceFileObservation[] = [];
          for (const relativePath of observedRelativePaths) {
            observations.push({
              relativePath,
              requestedSource: requestedSourceFilesByPath.get(relativePath) ?? null,
              installedSource: previousSourceFilesByPath.get(relativePath) ?? null,
              target: await requestUploadFile(destinationUploadRoutes, relativePath),
            });
          }

          try {
            return planMarketplaceWorkspaceUpdate({ observations });
          } catch (error) {
            if (error instanceof MarketplaceWorkspaceFileConflictError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );

      const execution = createBackofficeSystemExecution(input.targetScope);
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
      const preparedWrites: PreparedUploadFileWrite[] = [];
      for (const planned of workspaceUpdate.writes) {
        const { source } = planned;
        const targetPath = `/workspace/${source.relativePath}`;
        const stepKey = await sha256Hex(TEXT_ENCODER.encode(source.relativePath));

        const uploadSession = await step.do(
          `create marketplace artifact upload ${stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async () => {
            try {
              const sourceBytes = await requestMarketplaceArtifactBytes(
                sourceObject.http,
                source.fileKey,
              );
              await assertMarketplaceSourceBytesMatch(source, sourceBytes);
              const request = await targetFileSystem.resolveFileWriteUploadRequest(
                targetPath,
                sourceBytes,
                {
                  contentType: source.contentType,
                  precondition: planned.precondition,
                  ...(planned.mode === undefined ? {} : { mode: planned.mode }),
                },
              );
              const response = await destinationUploadRoutes("POST", "/uploads", {
                body: request.body,
              });
              if (response.type === "error") {
                return throwMarketplaceUploadRouteError({
                  operation: "Marketplace workspace upload creation",
                  status: response.status,
                  error: response.error,
                });
              }
              if (response.type !== "json") {
                return throwUnexpectedMarketplaceUploadResponse({
                  operation: "Marketplace workspace upload creation",
                  status: response.status,
                });
              }
              if (response.status < 200 || response.status >= 300) {
                return throwUnexpectedMarketplaceUploadResponse({
                  operation: "Marketplace workspace upload creation",
                  status: response.status,
                });
              }
              return {
                uploadId: response.data.uploadId,
                precondition: request.precondition,
              };
            } catch (error) {
              return throwMarketplaceUploadFileSystemError({
                operation: "Marketplace workspace upload creation",
                error,
              });
            }
          },
        );

        const prepared = await step.do(
          `transfer marketplace artifact upload ${stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async () => {
            try {
              const sourceBytes = await requestMarketplaceArtifactBytes(
                sourceObject.http,
                source.fileKey,
              );
              await assertMarketplaceSourceBytesMatch(source, sourceBytes);
              const response = await destinationUploadRoutes("PUT", "/uploads/:uploadId/content", {
                pathParams: { uploadId: uploadSession.uploadId },
                query: { provider: UPLOAD_PROVIDER_DATABASE },
                headers: { "content-type": "application/octet-stream" },
                body: new Blob([Uint8Array.from(sourceBytes)]),
              });
              if (response.type === "error") {
                return throwMarketplaceUploadRouteError({
                  operation: "Marketplace workspace upload transfer",
                  status: response.status,
                  error: response.error,
                });
              }
              if (response.type !== "json") {
                return throwUnexpectedMarketplaceUploadResponse({
                  operation: "Marketplace workspace upload transfer",
                  status: response.status,
                });
              }
              if (response.status < 200 || response.status >= 300) {
                return throwUnexpectedMarketplaceUploadResponse({
                  operation: "Marketplace workspace upload transfer",
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
                precondition: uploadSession.precondition,
              };
            } catch (error) {
              return throwMarketplaceUploadFileSystemError({
                operation: "Marketplace workspace upload transfer",
                error,
              });
            }
          },
        );
        preparedWrites.push(prepared);
      }

      await step.do(
        "commit marketplace workspace files",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async () => {
          if (
            preparedWrites.length === 0 &&
            workspaceUpdate.deletions.length === 0 &&
            workspaceUpdate.assertions.length === 0
          ) {
            return [];
          }

          try {
            return await targetFileSystem.commitPreparedFileWrites({
              writes: preparedWrites,
              deletions: workspaceUpdate.deletions,
              assertions: workspaceUpdate.assertions,
            });
          } catch (error) {
            if (error instanceof UploadFileWriteConflictError) {
              throw new NonRetryableError(
                `Marketplace ingestion conflicts with concurrently changed workspace files under '/workspace'.`,
              );
            }
            return throwMarketplaceUploadFileSystemError({
              operation: "Marketplace workspace batch commit",
              error,
            });
          }
        },
      );

      await step.do(
        "verify marketplace workspace files",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function verifyMarketplaceWorkspaceFiles() {
          for (const source of sourceFiles) {
            const target = await requestUploadFile(destinationUploadRoutes, source.relativePath);
            if (!marketplaceFileContentsMatch(source, target)) {
              throw new NonRetryableError(
                `Marketplace ingestion verification failed for '/workspace/${source.relativePath}'.`,
              );
            }
          }
          for (const deletion of workspaceUpdate.deletions) {
            const relativePath = deletion.path.slice("/workspace/".length);
            if (await requestUploadFile(destinationUploadRoutes, relativePath)) {
              throw new NonRetryableError(
                `Marketplace ingestion verification failed to remove '${deletion.path}'.`,
              );
            }
          }
        },
      );

      if (installationWorkflowFile) {
        const installationInput: MarketplaceInstallationWorkflowInput = {
          listingId: artifact.listingId,
          version: artifact.version,
          previousVersion: artifact.previousVersion,
          targetScope: input.targetScope,
          installationRoot: "/workspace",
          installedFiles: marketplaceInstalledFiles(sourceFiles),
          previousInstalledFiles: marketplaceInstalledFiles(previousSourceFiles),
        };
        const installationWorkflowInstanceId = marketplaceInstallationWorkflowInstanceId(
          event.instanceId,
        );
        const installationBaseExecution = createBackofficeServiceExecution({
          scope: input.targetScope,
          service: {
            type: "automation",
            id: `automation:${installationWorkflowInstanceId}`,
          },
        });
        const observedInstallationRunGeneration = await step.do(
          "observe marketplace installation workflow",
          async () => {
            const workflowsFragment = config.getWorkflowsFragment();
            if (!workflowsFragment) {
              throw new Error("Marketplace ingestion requires the local Workflows fragment.");
            }
            try {
              const metadata = await workflowsFragment.callServices(() =>
                workflowsFragment.services.getInstanceMetadata(
                  CODEMODE_WORKFLOW,
                  installationWorkflowInstanceId,
                ),
              );
              return metadata.runGeneration;
            } catch (error) {
              if (error instanceof WorkflowInstanceNotFoundError) {
                return 0;
              }
              throw error;
            }
          },
        );
        const installationWorkflowInput = await step.do(
          "start marketplace installation workflow",
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async () => {
            const workflowsFragment = config.getWorkflowsFragment();
            if (!workflowsFragment) {
              throw new Error("Marketplace ingestion requires the local Workflows fragment.");
            }
            const code = TEXT_DECODER.decode(
              await requestMarketplaceArtifactBytes(
                sourceObject.http,
                installationWorkflowFile.fileKey,
              ),
            );
            const execution = appendAutomationDelegate({
              execution: installationBaseExecution,
              delegate: CODEMODE_CAPABILITY_ACTOR,
            });
            let prepared;
            try {
              prepared = prepareCodemodeWorkflowInstance({
                code,
                filename: MARKETPLACE_INSTALL_WORKFLOW_PATH,
                instanceId: installationWorkflowInstanceId,
              });
            } catch (error) {
              throw new NonRetryableError(
                error instanceof Error
                  ? error.message
                  : "Marketplace installation workflow source is invalid.",
              );
            }
            const workflowInput = createCodemodeWorkflowInstanceInput({
              prepared,
              trigger: { type: "manual", payload: installationInput },
              execution,
              capabilityGrants: [
                {
                  actor: CODEMODE_CAPABILITY_ACTOR,
                  permissions: [
                    BACKOFFICE_PERMISSION.events.manage,
                    BACKOFFICE_PERMISSION.events.read,
                    BACKOFFICE_PERMISSION.identity.resolve,
                    BACKOFFICE_PERMISSION.otp.create,
                    BACKOFFICE_PERMISSION.pi.modify,
                    BACKOFFICE_PERMISSION.pi.read,
                    BACKOFFICE_PERMISSION.router.modify,
                    BACKOFFICE_PERMISSION.router.read,
                    BACKOFFICE_PERMISSION.store.modify,
                    BACKOFFICE_PERMISSION.store.read,
                    BACKOFFICE_PERMISSION.telegram.send,
                  ],
                },
              ],
            });
            const result = await workflowsFragment.callServices(() =>
              workflowsFragment.services.restartOrCreateInstance(workflowInput.workflowName, {
                id: workflowInput.instanceId,
                create: {
                  remoteWorkflowName: workflowInput.remoteWorkflowName,
                  params: withWorkflowCompletionTarget(workflowInput.params, {
                    workflowName: MARKETPLACE_INGEST_WORKFLOW_NAME,
                    instanceId: event.instanceId,
                  }),
                },
                restart: {
                  precondition: {
                    status: { in: ["complete", "errored", "terminated"] },
                    runGeneration: { equals: observedInstallationRunGeneration },
                  },
                },
              }),
            );
            return {
              workflowName: workflowInput.workflowName,
              instanceId: workflowInput.instanceId,
              runGeneration: result.details.runGeneration,
            };
          },
        );

        const completion = await step.waitForEvent<WorkflowCompletedEventPayload>(
          "wait for marketplace installation workflow",
          { type: workflowCompletedEventType(installationWorkflowInput.runGeneration) },
        );
        if (
          completion.payload.workflowName !== installationWorkflowInput.workflowName ||
          completion.payload.instanceId !== installationWorkflowInstanceId ||
          completion.payload.runGeneration !== installationWorkflowInput.runGeneration
        ) {
          throw new NonRetryableError("Received an unexpected workflow completion event.");
        }
        if (completion.payload.status !== "complete") {
          throw new NonRetryableError(
            completion.payload.error?.message ??
              `Marketplace installation workflow ended with status '${completion.payload.status}'.`,
          );
        }
      }

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
