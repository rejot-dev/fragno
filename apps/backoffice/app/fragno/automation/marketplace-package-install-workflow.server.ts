import {
  isMarketplaceLockPath,
  MARKETPLACE_LOCK_PATH,
  marketplaceListingIdSchema,
  marketplaceVersionSchema,
  type PackageInstallation,
} from "@fragno-dev/backoffice-api/v0/marketplace";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
  type BackofficeRoutableScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import type { PreparedFileWrite, UploadFileWritePrecondition } from "@fragno-dev/upload/types";
import {
  defineWorkflow,
  NonRetryableError,
  WorkflowInstanceNotFoundError,
} from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { createWorkflowsFragment } from "@fragno-dev/workflows";

import {
  createBackofficeServiceExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeObjectHandle, UploadCommands } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { readSavedWorkflowProgram } from "@/fragno/codemode/workflow-program";
import {
  assertPackagePermissionsApproved,
  EMPTY_MARKETPLACE_PACKAGE_DECLARATION,
  MARKETPLACE_DECLARATION_PATH,
  MarketplacePackageDeclarationError,
  parseMarketplacePackageDeclaration,
  resolveDeclaredPackageRoutes,
} from "@/fragno/marketplace/package-declaration";
import {
  isMarketplaceInternalPackagePath,
  MARKETPLACE_INSTALL_WORKFLOW_PATH,
  normalizeMarketplacePackagePath,
} from "@/fragno/marketplace/package-files";
import type { UploadFragment } from "@/fragno/upload-server";
import { sha256Hex } from "@/lib/crypto";

import { BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "./actors";
import { appendAutomationDelegate } from "./authority";
import {
  CODEMODE_CAPABILITY_ACTOR,
  CODEMODE_WORKFLOW,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import type { createAutomationFragment } from "./index";
import {
  marketplaceFileContentsMatch,
  MarketplaceWorkspaceFileConflictError,
  planMarketplaceWorkspaceInstallation,
  type MarketplaceIngestionSourceFile,
  type MarketplaceWorkspaceFileObservation,
  type MarketplaceWorkspaceRetiredFileObservation,
} from "./marketplace-ingestion-files";
import {
  assertMarketplaceIngestionTargetAccessible,
  assertMarketplaceIngestionSourceAccessible,
  assertMarketplaceIngestionTargetBelongsToOrganization,
  MarketplaceIngestionPackageUnavailableError,
  MarketplaceIngestionTargetAccessError,
  marketplaceIngestionWorkflowInputSchema,
  resolveMarketplaceIngestionPackageVersion,
} from "./marketplace-ingestions";
import {
  MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
  marketplaceInstallationWorkflowInstanceId,
} from "./marketplace-package-install-identity";
import {
  throwMarketplaceUploadRequestError,
  throwMarketplaceUploadRouteError,
  throwUnexpectedMarketplaceUploadResponse,
} from "./marketplace-upload-errors";
import {
  applyPackageInstallation,
  assertPackageInstallationReplaceable,
  PackageInstallationError,
  type PackageInstallationInput,
} from "./package-installations";
import { workflowCompletedEventType, type WorkflowCompletedEventPayload } from "./workflow-reply";

type PreparedWorkspaceWrite = PreparedFileWrite & { precondition: UploadFileWritePrecondition };

const MARKETPLACE_PACKAGE_LIST_PAGE_SIZE = 500;
const MARKETPLACE_PACKAGE_MAX_LIST_PAGES = 5;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MARKETPLACE_EXTERNAL_STEP_RETRIES = {
  retries: { limit: 3, delay: "1 s", backoff: "exponential" },
} as const;

const marketplacePackageInstallWorkflowOutputSchema = z.object({
  listingId: marketplaceListingIdSchema,
  version: marketplaceVersionSchema,
  workflowInstanceId: z.string(),
});

const UPLOAD_INTERNAL_ORIGIN = "https://upload.internal";

type UploadHttpTransport = Pick<BackofficeObjectHandle<UploadCommands>["http"], "fetch">;

const createUploadRouteCaller = (http: UploadHttpTransport) =>
  createRouteCaller<UploadFragment>({
    baseUrl: UPLOAD_INTERNAL_ORIGIN,
    mountRoute: "/api/upload",
    fetch: (request) => http.fetch(request),
  });

type UploadRouteCaller = ReturnType<typeof createUploadRouteCaller>;

const requestMarketplacePackageBytes = async (http: UploadHttpTransport, fileKey: string) => {
  const url = new URL("/api/upload/files/by-key/content", UPLOAD_INTERNAL_ORIGIN);
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
      operation: "Marketplace package content read",
      status: response.status,
      code,
      message,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
};

const requestUploadFile = async (callRoute: UploadRouteCaller, fileKey: string) => {
  const response = await callRoute("GET", "/files/by-key", {
    query: { key: fileKey },
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

const assertMarketplaceSourceBytesMatch = async (
  source: MarketplaceIngestionSourceFile,
  bytes: Uint8Array,
) => {
  if (source.checksum.algo !== "sha256") {
    throw new NonRetryableError(
      `Marketplace package file '${source.fileKey}' uses unsupported checksum '${source.checksum.algo}'.`,
    );
  }
  if (bytes.byteLength !== source.sizeBytes) {
    throw new NonRetryableError(
      `Marketplace package file '${source.fileKey}' changed size while it was being ingested.`,
    );
  }
  const checksum = await sha256Hex(bytes);
  if (checksum !== source.checksum.value.toLowerCase()) {
    throw new NonRetryableError(
      `Marketplace package file '${source.fileKey}' changed content while it was being ingested.`,
    );
  }
};

type MarketplaceWorkflowsFragment = Pick<
  ReturnType<typeof createWorkflowsFragment<BackofficeExecutionContext>>,
  "callServices" | "services"
>;

type MarketplacePackageInstallWorkflowConfig = {
  ownerScope: BackofficeContextScope;
  env?: CloudflareEnv;
  runtime?: BackofficeRuntimeServices;
  getAutomationFragment: () => ReturnType<typeof createAutomationFragment> | undefined;
  getWorkflowsFragment: () => MarketplaceWorkflowsFragment | undefined;
};

/**
 * What a package's install workflow receives. Installing again restarts the workflow with its
 * original input, so it reads the current installation and settings with `packages.get` instead.
 */
type MarketplaceInstallationWorkflowInput = {
  listingId: string;
  version: string;
  targetScope: BackofficeRoutableScope;
  installationRoot: string;
  installedFiles: Record<string, string>;
};

/**
 * Install published package files, run the package's install workflow, then record the installation
 * with its declared routes and event definitions, and sync its declared agents, in the destination
 * workspace.
 */
export function defineMarketplacePackageInstallWorkflow(
  config: MarketplacePackageInstallWorkflowConfig,
) {
  return defineWorkflow(
    {
      name: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
      schema: marketplaceIngestionWorkflowInputSchema,
      outputSchema: marketplacePackageInstallWorkflowOutputSchema,
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
        assertMarketplaceIngestionSourceAccessible({
          organizationId,
          marketplace: input.marketplace,
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
              // This organization's projects are stored here; any other owner stores its own.
              projectExists: async ({ owner, projectId }) =>
                Boolean(
                  backofficeContextScopesEqual(owner, ownerScope)
                    ? await automationFragment.callServices(() =>
                        automationFragment.services.resolveProjectForExecution({ projectId }),
                      )
                    : await runtime.objects.automations
                        .for(owner)
                        .commands.resolveProjectForExecution({ projectId }),
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

      const release = await step.do(
        "resolve published marketplace package",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function resolvePublishedMarketplacePackage() {
          const manifest = await runtime.objects.marketplace
            .for(input.marketplace)
            .commands.getListingStorage({
              listingId: input.listingId,
            });
          let resolvedPackage;
          try {
            resolvedPackage = resolveMarketplaceIngestionPackageVersion(manifest, input.version);
          } catch (error) {
            if (error instanceof MarketplaceIngestionPackageUnavailableError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
          return {
            listingId: resolvedPackage.manifest.listingId,
            version: resolvedPackage.version,
            uploadName: resolvedPackage.manifest.uploadName,
            filePrefix: `${resolvedPackage.version}/`,
          };
        },
      );

      const sourceObject = runtime.objects.upload.forName(release.uploadName);
      const sourceUploadRoutes = createUploadRouteCaller(sourceObject.http);

      /** Published versions are immutable, so a listing is stable across replays. */
      async function listPackageFiles(version: string, stepName: string) {
        const packagePrefix = `${version}/`;
        const files: MarketplaceIngestionSourceFile[] = [];
        let cursor: string | undefined;

        for (let pageIndex = 0; pageIndex < MARKETPLACE_PACKAGE_MAX_LIST_PAGES; pageIndex += 1) {
          const pageCursor = cursor;
          const page = await step.do(stepName, MARKETPLACE_EXTERNAL_STEP_RETRIES, async () => {
            const response = await sourceUploadRoutes("GET", "/files", {
              query: {
                prefix: packagePrefix,
                status: "ready",
                pageSize: String(MARKETPLACE_PACKAGE_LIST_PAGE_SIZE),
                ...(pageCursor ? { cursor: pageCursor } : {}),
              },
            });
            if (response.type !== "json" || response.status < 200 || response.status >= 300) {
              throw new Error(`Failed to list Marketplace package files (${response.status}).`);
            }

            const pageFiles: MarketplaceIngestionSourceFile[] = [];
            for (const file of response.data.files) {
              if (file.metadata?.__docsDirectoryMarker === true) {
                continue;
              }
              const relativePath = normalizeMarketplacePackagePath(
                file.fileKey.slice(packagePrefix.length),
              );
              const checksum = file.checksum;
              if (!checksum) {
                throw new NonRetryableError(
                  `Marketplace package file '${file.fileKey}' has no checksum.`,
                );
              }
              pageFiles.push({
                fileKey: file.fileKey,
                relativePath,
                contentType: file.contentType,
                sizeBytes: file.sizeBytes,
                checksum,
              });
            }

            return {
              files: pageFiles,
              cursor: response.data.cursor,
              hasNextPage: response.data.hasNextPage,
            };
          });
          files.push(...page.files);

          if (!page.hasNextPage) {
            return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
          }
          if (!page.cursor) {
            throw new NonRetryableError(
              "Marketplace package listing reported another page without a cursor.",
            );
          }
          cursor = page.cursor;
        }

        throw new NonRetryableError(
          `Marketplace package listing exceeds ${MARKETPLACE_PACKAGE_MAX_LIST_PAGES} pages.`,
        );
      }

      const requestedPackageFiles = await listPackageFiles(
        release.version,
        "list marketplace package files page",
      );
      if (requestedPackageFiles.length === 0) {
        throw new NonRetryableError("Marketplace package contains no files.");
      }
      const installationWorkflowFile = requestedPackageFiles.find(
        (file) => file.relativePath === MARKETPLACE_INSTALL_WORKFLOW_PATH,
      );
      const sourceFiles = requestedPackageFiles.filter(
        (file) => !isMarketplaceInternalPackagePath(file.relativePath),
      );
      if (
        sourceFiles.some((file) =>
          isMarketplaceLockPath(`${input.installationRoot}/${file.relativePath}`),
        )
      ) {
        throw new NonRetryableError(
          "Marketplace packages cannot overwrite /workspace/marketplace-lock.json.",
        );
      }

      const destinationObject = runtime.objects.upload.for(input.targetScope);
      const destinationUploadRoutes = createUploadRouteCaller(destinationObject.http);
      // This organization's workspace stores its installations here; any other target stores its own.
      const targetIsCoordinator = backofficeContextScopesEqual(input.targetScope, ownerScope);
      const targetAutomations = () => {
        const automationFragment = config.getAutomationFragment();
        if (!automationFragment) {
          throw new Error("Marketplace ingestion requires the local Automations fragment.");
        }
        return automationFragment;
      };

      const readInstallationRecord = async () => {
        const listingId = release.listingId;
        return targetIsCoordinator
          ? await targetAutomations().callServices(() =>
              targetAutomations().services.getPackageInstallationRecord({ listingId }),
            )
          : await runtime.objects.automations
              .for(input.targetScope)
              .commands.getPackageInstallationRecord({ listingId });
      };

      // Installing again, or another release meanwhile, is another run with its own operation. Each
      // commits only over the installation it read, so overlapping runs can't mix their releases.
      const { installedVersion, expectedOperation, operation } = await step.do(
        "read package installation",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function readPackageInstallation() {
          const listingId = release.listingId;
          const record = await readInstallationRecord();
          const existing = record?.installation ?? null;
          try {
            assertPackageInstallationReplaceable(existing, {
              listingId,
              marketplace: input.marketplace,
              installationRoot: input.installationRoot,
            });
          } catch (error) {
            if (error instanceof PackageInstallationError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
          if (record) {
            return {
              installedVersion: record.installation.version,
              expectedOperation: record.operation,
              operation: crypto.randomUUID(),
            };
          }
          // Without its records, an upgrade would see its own installed files as someone else's, and
          // a listing could be installed a second time elsewhere.
          if (
            await requestUploadFile(
              destinationUploadRoutes,
              MARKETPLACE_LOCK_PATH.slice("/workspace/".length),
            )
          ) {
            throw new NonRetryableError(
              `This workspace still records installations in ${MARKETPLACE_LOCK_PATH}. Import them with packages.importLegacy, then install again.`,
            );
          }
          return {
            installedVersion: null,
            expectedOperation: null,
            operation: crypto.randomUUID(),
          };
        },
      );

      const declarationFile = requestedPackageFiles.find(
        (file) => file.relativePath === MARKETPLACE_DECLARATION_PATH,
      );
      const declared = await step.do(
        "resolve marketplace package declaration",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function resolveMarketplacePackageDeclaration() {
          try {
            const declaration = declarationFile
              ? parseMarketplacePackageDeclaration(
                  TEXT_DECODER.decode(
                    await requestMarketplacePackageBytes(
                      sourceObject.http,
                      declarationFile.fileKey,
                    ),
                  ),
                )
              : EMPTY_MARKETPLACE_PACKAGE_DECLARATION;
            assertPackagePermissionsApproved({
              declared: declaration.permissions,
              approved: input.permissions,
            });
            return {
              routes: resolveDeclaredPackageRoutes({
                declaration,
                installationRoot: input.installationRoot,
                installedPaths: new Set(sourceFiles.map((file) => file.relativePath)),
              }),
              eventDefinitions: declaration.eventDefinitions,
              agents: declaration.agents,
            };
          } catch (error) {
            if (error instanceof MarketplacePackageDeclarationError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );
      // Installing another version at an occupied root upgrades (or downgrades) it in place.
      const previousFiles =
        installedVersion === null || installedVersion === release.version
          ? []
          : (
              await listPackageFiles(
                installedVersion,
                "list installed marketplace package files page",
              )
            ).filter((file) => !isMarketplaceInternalPackagePath(file.relativePath));
      const previousFilesByPath = new Map(previousFiles.map((file) => [file.relativePath, file]));
      const sourcePaths = new Set(sourceFiles.map((file) => file.relativePath));
      const installationPlan = await step.do(
        "plan marketplace workspace writes",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function planMarketplaceWorkspaceWrites() {
          const readTarget = (relativePath: string) =>
            requestUploadFile(
              destinationUploadRoutes,
              `${input.installationRoot}/${relativePath}`.slice("/workspace/".length),
            );
          const observations: MarketplaceWorkspaceFileObservation[] = [];
          for (const source of sourceFiles) {
            observations.push({
              source,
              previous: previousFilesByPath.get(source.relativePath) ?? null,
              target: await readTarget(source.relativePath),
            });
          }
          const retired: MarketplaceWorkspaceRetiredFileObservation[] = [];
          for (const previous of previousFiles) {
            if (!sourcePaths.has(previous.relativePath)) {
              retired.push({ previous, target: await readTarget(previous.relativePath) });
            }
          }

          try {
            return planMarketplaceWorkspaceInstallation({
              installationRoot: input.installationRoot,
              observations,
              retired,
            });
          } catch (error) {
            if (error instanceof MarketplaceWorkspaceFileConflictError) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );

      const preparedWrites: PreparedWorkspaceWrite[] = [];
      for (const planned of installationPlan.writes) {
        const { source } = planned;
        const targetPath = `${input.installationRoot}/${source.relativePath}`;
        const stepKey = await sha256Hex(TEXT_ENCODER.encode(source.relativePath));

        const uploadSession = await step.do(
          `create marketplace package upload ${stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async () => {
            const sourceBytes = await requestMarketplacePackageBytes(
              sourceObject.http,
              source.fileKey,
            );
            await assertMarketplaceSourceBytesMatch(source, sourceBytes);
            const response = await destinationUploadRoutes("POST", "/uploads", {
              body: {
                fileKey: targetPath.slice("/workspace/".length),
                filename: source.relativePath.split("/").at(-1)!,
                sizeBytes: sourceBytes.byteLength,
                contentType: source.contentType,
                checksum: source.checksum,
                publicationMode: "batch",
              },
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
              precondition: planned.precondition,
            };
          },
        );

        const prepared = await step.do(
          `transfer marketplace package upload ${stepKey}`,
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async () => {
            const sourceBytes = await requestMarketplacePackageBytes(
              sourceObject.http,
              source.fileKey,
            );
            await assertMarketplaceSourceBytesMatch(source, sourceBytes);
            const response = await destinationUploadRoutes("PUT", "/uploads/:uploadId/content", {
              pathParams: { uploadId: uploadSession.uploadId },
              query: {},
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
            installationPlan.deletes.length === 0 &&
            installationPlan.assertions.length === 0
          ) {
            return [];
          }

          const response = await destinationUploadRoutes("POST", "/files/commit-prepared", {
            body: {
              entries: [
                ...preparedWrites.map((write) => ({
                  kind: "write" as const,
                  uploadId: write.uploadId,
                  precondition: write.precondition,
                })),
                ...installationPlan.deletes.map((deletion) => ({
                  kind: "delete" as const,
                  fileKey: deletion.path.slice("/workspace/".length),
                  precondition: { kind: "revision" as const, revision: deletion.revision },
                })),
                ...installationPlan.assertions.map((assertion) => ({
                  kind: "assert" as const,
                  fileKey: assertion.path.slice("/workspace/".length),
                  precondition: assertion.precondition,
                })),
              ],
            },
          });
          if (response.type === "error") {
            if (response.error.code === "FILE_PRECONDITION_FAILED") {
              throw new NonRetryableError(
                `Marketplace ingestion conflicts with concurrently changed workspace files under '${input.installationRoot}'.`,
              );
            }
            return throwMarketplaceUploadRouteError({
              operation: "Marketplace workspace batch commit",
              status: response.status,
              error: response.error,
            });
          }
          if (response.type !== "json") {
            return throwUnexpectedMarketplaceUploadResponse({
              operation: "Marketplace workspace batch commit",
              status: response.status,
            });
          }
          return response.data.files;
        },
      );

      await step.do(
        "verify marketplace workspace files",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function verifyMarketplaceWorkspaceFiles() {
          for (const source of sourceFiles) {
            const target = await requestUploadFile(
              destinationUploadRoutes,
              `${input.installationRoot}/${source.relativePath}`.slice("/workspace/".length),
            );
            if (!marketplaceFileContentsMatch(source, target)) {
              throw new NonRetryableError(
                `Marketplace ingestion verification failed for '${input.installationRoot}/${source.relativePath}'.`,
              );
            }
          }
        },
      );

      let settings: PackageInstallation["settings"] = {};
      if (installationWorkflowFile) {
        const installationInput: MarketplaceInstallationWorkflowInput = {
          listingId: release.listingId,
          version: release.version,
          targetScope: input.targetScope,
          installationRoot: input.installationRoot,
          installedFiles: Object.fromEntries(
            sourceFiles.map((file) => [
              file.relativePath,
              `${input.installationRoot}/${file.relativePath}`,
            ]),
          ),
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
              await requestMarketplacePackageBytes(
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
              const path = `/${MARKETPLACE_INSTALL_WORKFLOW_PATH}`;
              const program = await readSavedWorkflowProgram({
                path,
                // The workflow comes from the package, not the workspace it installs into.
                readFile: async (modulePath) => {
                  if (modulePath !== path) {
                    throw new Error("Marketplace installation workflows import no modules.");
                  }
                  return code;
                },
              });
              prepared = prepareCodemodeWorkflowInstance({
                program,
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
                  // Routes come only from declarations, so the package's code can't write them.
                  // Reading installations lets it see its current settings.
                  permissions: [
                    ...input.permissions.filter(
                      ({ namespace, permission }) =>
                        !(namespace === "router" && permission === "modify") &&
                        !(namespace === "packages" && permission === "read"),
                    ),
                    BACKOFFICE_PERMISSION.packages.read,
                  ],
                },
              ],
              replyTo: {
                kind: "workflow",
                workflowName: MARKETPLACE_PACKAGE_INSTALL_WORKFLOW_NAME,
                instanceId: event.instanceId,
              },
            });
            const result = await workflowsFragment.callServices(() =>
              workflowsFragment.services.restartOrCreateInstance(workflowInput.workflowName, {
                id: workflowInput.instanceId,
                create: {
                  remoteWorkflowName: workflowInput.remoteWorkflowName,
                  params: workflowInput.params,
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
        const output = completion.payload.output;
        if (output !== undefined && output !== null) {
          if (typeof output !== "object" || Array.isArray(output)) {
            throw new NonRetryableError(
              "A Marketplace install workflow returns its settings as an object, or nothing.",
            );
          }
          settings = output as PackageInstallation["settings"];
        }
      }

      const actors = input.metadata[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY];
      // Agents live in the Pi manager, outside the installation's transaction. They are checked
      // before it commits and written after, so a refused installation writes no agents, and a
      // retried agent step finds the installation it belongs to.
      const piManager = () => runtime.objects.piManager.for(input.targetScope).commands;
      await step.do(
        "apply package installation",
        MARKETPLACE_EXTERNAL_STEP_RETRIES,
        async function applyInstallation() {
          if (runtime.config.bindings.piManager) {
            const agents = await piManager().checkPackageAgents({
              listingId: release.listingId,
              agents: declared.agents,
            });
            if (!agents.ok) {
              throw new NonRetryableError(agents.message);
            }
          } else if (declared.agents.length > 0) {
            throw new NonRetryableError("This package defines agents, but Pi is not available.");
          }
          const installationInput: PackageInstallationInput = {
            installation: {
              marketplace: input.marketplace,
              listingId: release.listingId,
              version: release.version,
              installationRoot: input.installationRoot,
              permissions: input.permissions,
              settings,
            },
            operation,
            expectedOperation,
            routes: declared.routes,
            eventDefinitions: declared.eventDefinitions,
            actors,
          };
          const outcome = targetIsCoordinator
            ? await applyPackageInstallation(targetAutomations(), installationInput)
            : await runtime.objects.automations
                .for(input.targetScope)
                .commands.applyPackageInstallation(installationInput);
          if (!outcome.ok) {
            throw new NonRetryableError(outcome.message);
          }
        },
      );

      if (runtime.config.bindings.piManager) {
        await step.do(
          "apply package agents",
          MARKETPLACE_EXTERNAL_STEP_RETRIES,
          async function applyAgents() {
            // A retry can come after another run or an uninstall replaced this installation, whose
            // agents it would then overwrite.
            if ((await readInstallationRecord())?.operation !== operation) {
              throw new NonRetryableError(
                `Package '${release.listingId}' was installed again or uninstalled before this installation defined its agents.`,
              );
            }
            const outcome = await piManager().applyPackageAgents({
              listingId: release.listingId,
              agents: declared.agents,
              actors,
            });
            if (!outcome.ok) {
              throw new NonRetryableError(outcome.message);
            }
          },
        );
      }

      return {
        listingId: release.listingId,
        version: release.version,
        workflowInstanceId: event.instanceId,
      };
    },
  );
}
