import type { ClientOptions as CloudflareClientOptions } from "cloudflare";

import { defineFragment } from "@fragno-dev/core";
import { ExponentialBackoffRetryPolicy, withDatabase, type HookFn } from "@fragno-dev/db";

import {
  createCloudflareApiClient,
  getCloudflareApiError,
  reconcileCloudflareWorkerDeployment,
  resolveCloudflareDispatchNamespaceName,
  type CloudflareApiClient,
  type CloudflareDispatcherConfig,
  type CloudflareScriptUpdateResponse,
} from "./cloudflare-api";
import {
  SUPPORTED_DEPLOYMENT_FORMAT,
  type CloudflareAppSummary,
  type CloudflareDeployRequest,
  type CloudflareDeploymentDetail,
  type CloudflareDeploymentSummary,
} from "./contracts";
import { cloudflareSchema } from "./schema";
import { resolveCloudflareScriptName, type CloudflareScriptNameConfig } from "./script-name";

type DeploymentRow = {
  id: { valueOf(): string };
  status: string;
  format: string;
  entrypoint: string;
  scriptName: string;
  sourceByteLength: number;
  compatibilityDate: string;
  compatibilityFlags: unknown;
  attemptCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  cloudflareEtag: string | null;
  cloudflareModifiedOn: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type AppRow = {
  id: { valueOf(): string };
  scriptName: string;
  liveDeploymentId: string | null;
  liveCloudflareEtag: string | null;
  firstDeploymentLeaseId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CloudflareLiveDeploymentSnapshot = {
  currentDeploymentTag: string;
  currentDeploymentId: string | null;
  currentEtag: string | null;
  currentModifiedOn: string | null;
};

type DeployWorkerRemoteResult =
  | Awaited<ReturnType<typeof reconcileCloudflareWorkerDeployment>>
  | ({ action: "superseded" } & CloudflareLiveDeploymentSnapshot);

type FirstDeploymentPreparation =
  | { action: "missing" }
  | { action: "retry" }
  | { action: "continue" }
  | ({ action: "superseded" } & CloudflareLiveDeploymentSnapshot);

type LivePointerGuard =
  | {
      kind: "etag";
      expectedLiveEtag: string;
    }
  | {
      kind: "first-deploy";
      leaseDeploymentId: string;
    };

const textEncoder = new TextEncoder();
const hookWriteRetryPolicy = new ExponentialBackoffRetryPolicy({
  maxRetries: 5,
  initialDelayMs: 10,
  maxDelayMs: 250,
});

type CloudflareFragmentSharedConfig = CloudflareScriptNameConfig & {
  accountId: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  scriptTags?: string[];
  deploymentTagPrefix?: string;
};

type CloudflareFragmentApiTokenConfig = {
  apiToken: string;
  cloudflare?: never;
  fetchImplementation?: CloudflareClientOptions["fetch"];
};

type CloudflareFragmentClientConfig = {
  cloudflare: CloudflareApiClient;
  apiToken?: never;
  fetchImplementation?: never;
};

export type CloudflareFragmentConfig = CloudflareFragmentSharedConfig &
  (CloudflareFragmentApiTokenConfig | CloudflareFragmentClientConfig) &
  (
    | {
        dispatcher: CloudflareDispatcherConfig;
        dispatchNamespace?: never;
      }
    | {
        dispatchNamespace: string;
        dispatcher?: never;
      }
  );

export type DeployWorkerHookInput = {
  deploymentId: string;
  appId: string;
  expectedLiveEtag: string | null;
  scriptName: string;
  entrypoint: string;
  moduleContent: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
};

export type CloudflareHooksMap = {
  deployWorker: HookFn<DeployWorkerHookInput>;
};

const resolveDispatcherConfig = (config: CloudflareFragmentConfig): CloudflareDispatcherConfig => {
  if ("dispatcher" in config && config.dispatcher !== undefined) {
    return config.dispatcher;
  }

  if ("dispatchNamespace" in config && config.dispatchNamespace !== undefined) {
    return config.dispatchNamespace;
  }

  throw new Error(
    "Cloudflare fragment requires `dispatcher` or `dispatchNamespace` to resolve the dispatch namespace name.",
  );
};

const normalizeStringList = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
};

const toIsoDateTime = (value: Date | null) => {
  return value ? value.toISOString() : null;
};

const buildDeploymentSummary = (
  deployment: DeploymentRow,
  appId: string,
): CloudflareDeploymentSummary => {
  const cloudflare =
    deployment.cloudflareEtag || deployment.cloudflareModifiedOn
      ? {
          etag: deployment.cloudflareEtag,
          modifiedOn: deployment.cloudflareModifiedOn,
        }
      : null;

  return {
    id: deployment.id.valueOf(),
    appId,
    scriptName: deployment.scriptName,
    status:
      deployment.status === "queued" ||
      deployment.status === "deploying" ||
      deployment.status === "succeeded" ||
      deployment.status === "failed"
        ? deployment.status
        : "failed",
    format:
      deployment.format === SUPPORTED_DEPLOYMENT_FORMAT ? SUPPORTED_DEPLOYMENT_FORMAT : "esmodule",
    entrypoint: deployment.entrypoint,
    sourceByteLength: deployment.sourceByteLength,
    compatibilityDate: deployment.compatibilityDate,
    compatibilityFlags: normalizeStringList(deployment.compatibilityFlags),
    attemptCount: deployment.attemptCount,
    queuedAt: deployment.createdAt.toISOString(),
    startedAt: toIsoDateTime(deployment.startedAt),
    completedAt: toIsoDateTime(deployment.completedAt),
    errorCode: deployment.errorCode,
    errorMessage: deployment.errorMessage,
    cloudflare,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
  };
};

const buildDeploymentDetail = (
  deployment: DeploymentRow & { sourceCode?: string },
  appId: string,
): CloudflareDeploymentDetail => {
  return {
    ...buildDeploymentSummary(deployment, appId),
    sourceCode: deployment.sourceCode ?? "",
  };
};

const buildAppSummary = (
  app: AppRow,
  latestDeployment: DeploymentRow | null,
): CloudflareAppSummary => {
  return {
    id: app.id.valueOf(),
    scriptName: app.scriptName,
    latestDeployment: latestDeployment
      ? buildDeploymentSummary(latestDeployment, app.id.valueOf())
      : null,
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
};

const formatDeployError = (error: unknown) => {
  const cloudflareError = getCloudflareApiError(error);
  if (cloudflareError) {
    return {
      code: cloudflareError.code,
      message: cloudflareError.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: error.message,
    };
  }

  return {
    code: "unknown",
    message: String(error),
  };
};

const readCloudflareSummary = (response: CloudflareScriptUpdateResponse) => {
  return {
    etag: response.etag ?? null,
    modifiedOn: response.modified_on ?? null,
    raw: response,
  };
};

const createLivePointerGuard = (input: DeployWorkerHookInput): LivePointerGuard => {
  if (input.expectedLiveEtag !== null) {
    return {
      kind: "etag",
      expectedLiveEtag: input.expectedLiveEtag,
    };
  }

  return {
    kind: "first-deploy",
    leaseDeploymentId: input.deploymentId,
  };
};

const canPromoteDeploymentToLive = (
  app: AppRow,
  deploymentId: string,
  livePointerGuard: LivePointerGuard,
) => {
  if (livePointerGuard.kind === "first-deploy") {
    return (
      app.liveCloudflareEtag === null &&
      app.firstDeploymentLeaseId === livePointerGuard.leaseDeploymentId
    );
  }

  return (
    app.liveCloudflareEtag === livePointerGuard.expectedLiveEtag ||
    app.liveDeploymentId === deploymentId
  );
};

export const cloudflareFragmentDefinition = defineFragment<CloudflareFragmentConfig>(
  "cloudflare-fragment",
)
  .extend(withDatabase(cloudflareSchema))
  .withDependencies(({ config }) => {
    const dispatchNamespace = resolveCloudflareDispatchNamespaceName(
      resolveDispatcherConfig(config),
    );
    const cloudflare =
      "cloudflare" in config && config.cloudflare
        ? config.cloudflare
        : createCloudflareApiClient({
            apiToken: config.apiToken,
            fetchImplementation: config.fetchImplementation,
          });

    return {
      cloudflare,
      dispatchNamespace,
    };
  })
  .providesService("cloudflare", ({ deps }) => ({
    getClient: () => deps.cloudflare,
  }))
  .provideHooks<CloudflareHooksMap>(({ defineHook, deps, config }) => ({
    deployWorker: defineHook(async function (input) {
      // Cloudflare CAS starts once the app has a live etag. The first deploy uses a local
      // lease so we still get compare-and-swap semantics before that point.
      const livePointerGuard = createLivePointerGuard(input);
      let remoteResult: DeployWorkerRemoteResult | null = null;
      let remoteError: unknown = null;
      let remoteUploadAttempted = false;

      const prepareFirstDeployment = async (): Promise<FirstDeploymentPreparation | null> => {
        if (livePointerGuard.kind !== "first-deploy") {
          return null;
        }

        return await this.handlerTx({ retryPolicy: hookWriteRetryPolicy })
          .retrieve(({ forSchema }) =>
            forSchema(cloudflareSchema).findFirst("deployment", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", input.deploymentId))
                .joinOne("app", "app", (app) =>
                  app.onIndex("primary", (eb) => eb("id", "=", eb.parent("appId"))),
                ),
            ),
          )
          .mutate(({ forSchema, retrieveResult: [deployment] }) => {
            if (!deployment?.app) {
              return { action: "missing" as const };
            }

            const uow = forSchema(cloudflareSchema);
            const now = uow.now();
            const deploymentId = deployment.id.valueOf();
            const app = deployment.app;

            if (app.liveCloudflareEtag !== null) {
              if (app.firstDeploymentLeaseId === deploymentId) {
                uow.update("app", app.id, (b) =>
                  b
                    .set({
                      updatedAt: now,
                      firstDeploymentLeaseId: null,
                    })
                    .check(),
                );
              }

              return {
                action: "superseded" as const,
                currentDeploymentId: app.liveDeploymentId,
                currentDeploymentTag: app.liveDeploymentId ?? "current-live-deployment",
                currentEtag: app.liveCloudflareEtag,
                currentModifiedOn: null,
              };
            }

            if (
              app.firstDeploymentLeaseId !== null &&
              app.firstDeploymentLeaseId !== deploymentId
            ) {
              return { action: "retry" as const };
            }

            if (app.firstDeploymentLeaseId !== deploymentId) {
              uow.update("app", app.id, (b) =>
                b
                  .set({
                    updatedAt: now,
                    firstDeploymentLeaseId: deploymentId,
                  })
                  .check(),
              );
            }

            return { action: "continue" as const };
          })
          .execute();
      };

      const firstDeploymentPreparation = await prepareFirstDeployment();
      if (firstDeploymentPreparation?.action === "missing") {
        return;
      }

      if (firstDeploymentPreparation?.action === "retry") {
        throw new Error(
          `Initial Cloudflare deploy for '${input.scriptName}' is already in progress.`,
        );
      }

      if (firstDeploymentPreparation?.action === "superseded") {
        remoteResult = firstDeploymentPreparation;
      }

      if (!remoteResult) {
        remoteUploadAttempted = true;

        try {
          remoteResult = await reconcileCloudflareWorkerDeployment(deps.cloudflare, {
            accountId: config.accountId,
            dispatchNamespace: deps.dispatchNamespace,
            appId: input.appId,
            deploymentId: input.deploymentId,
            expectedLiveEtag: input.expectedLiveEtag,
            deploymentTagPrefix: config.deploymentTagPrefix,
            scriptName: input.scriptName,
            entrypoint: input.entrypoint,
            moduleContent: input.moduleContent,
            compatibilityDate: input.compatibilityDate,
            compatibilityFlags: input.compatibilityFlags,
            scriptTags: config.scriptTags,
          });
        } catch (error) {
          remoteError = error;
        }
      }

      const remoteDeploymentId =
        remoteResult?.action === "superseded" || remoteResult?.action === "already-deployed"
          ? remoteResult.currentDeploymentId
          : null;
      const finalizeDeploymentStateTx =
        remoteDeploymentId && remoteDeploymentId !== input.deploymentId
          ? this.handlerTx({ retryPolicy: hookWriteRetryPolicy })
              .retrieve(({ forSchema }) =>
                forSchema(cloudflareSchema)
                  .findFirst("deployment", (b) =>
                    b
                      .whereIndex("primary", (eb) => eb("id", "=", input.deploymentId))
                      .joinOne("app", "app", (app) =>
                        app.onIndex("primary", (eb) => eb("id", "=", eb.parent("appId"))),
                      ),
                  )
                  .findFirst("deployment", (b) =>
                    b.whereIndex("primary", (eb) => eb("id", "=", remoteDeploymentId)),
                  ),
              )
              .transformRetrieve(([deployment, remoteDeployment]) => ({
                deployment,
                remoteDeployment: remoteDeployment ?? null,
              }))
          : this.handlerTx({ retryPolicy: hookWriteRetryPolicy })
              .retrieve(({ forSchema }) =>
                forSchema(cloudflareSchema).findFirst("deployment", (b) =>
                  b
                    .whereIndex("primary", (eb) => eb("id", "=", input.deploymentId))
                    .joinOne("app", "app", (app) =>
                      app.onIndex("primary", (eb) => eb("id", "=", eb.parent("appId"))),
                    ),
                ),
              )
              .transformRetrieve(([deployment]) => ({
                deployment,
                remoteDeployment: null,
              }));

      await finalizeDeploymentStateTx
        .mutate(({ forSchema, retrieveResult: { deployment, remoteDeployment } }) => {
          if (!deployment || !deployment.app) {
            return;
          }

          const uow = forSchema(cloudflareSchema);
          const now = uow.now();
          const appId = deployment.app.id;
          const deploymentId = deployment.id.valueOf();
          const ownsFirstDeploymentLease = deployment.app.firstDeploymentLeaseId === deploymentId;
          const updateApp = (
            changes: Partial<{
              liveDeploymentId: string | null;
              liveCloudflareEtag: string | null;
            }> = {},
          ) => {
            uow.update("app", appId, (b) =>
              b
                .set({
                  updatedAt: now,
                  ...changes,
                  ...(ownsFirstDeploymentLease ? { firstDeploymentLeaseId: null } : {}),
                })
                .check(),
            );
          };

          if (remoteResult?.action === "already-deployed") {
            const etag =
              remoteResult.currentEtag ??
              deployment.cloudflareEtag ??
              (deployment.app.liveDeploymentId === deploymentId
                ? deployment.app.liveCloudflareEtag
                : null);
            const modifiedOn = remoteResult.currentModifiedOn ?? deployment.cloudflareModifiedOn;

            uow.update("deployment", deployment.id, (b) =>
              b
                .set({
                  status: "succeeded",
                  updatedAt: now,
                  startedAt: deployment.startedAt ?? now,
                  completedAt: deployment.completedAt ?? now,
                  attemptCount: Math.max(deployment.attemptCount, 1),
                  errorCode: null,
                  errorMessage: null,
                  cloudflareEtag: etag,
                  cloudflareModifiedOn: modifiedOn,
                })
                .check(),
            );
            updateApp({
              liveDeploymentId: deploymentId,
              liveCloudflareEtag: etag,
            });
            return;
          }

          if (remoteResult?.action === "uploaded") {
            const cloudflare = readCloudflareSummary(remoteResult.response);
            const canMoveLivePointer = canPromoteDeploymentToLive(
              deployment.app,
              deploymentId,
              livePointerGuard,
            );

            uow.update("deployment", deployment.id, (b) =>
              b
                .set({
                  status: "succeeded",
                  updatedAt: now,
                  startedAt: deployment.startedAt ?? now,
                  completedAt: now,
                  attemptCount: deployment.attemptCount + 1,
                  errorCode: null,
                  errorMessage: null,
                  cloudflareEtag: cloudflare.etag,
                  cloudflareModifiedOn: cloudflare.modifiedOn,
                  cloudflareResponse: cloudflare.raw,
                })
                .check(),
            );
            updateApp(
              canMoveLivePointer
                ? {
                    liveDeploymentId: deploymentId,
                    liveCloudflareEtag: cloudflare.etag,
                  }
                : {},
            );
            return;
          }

          if (remoteResult?.action === "superseded") {
            const supersededBy =
              remoteDeployment?.id.valueOf() ??
              remoteResult.currentDeploymentId ??
              remoteResult.currentDeploymentTag;
            const winnerEtag =
              remoteResult.currentEtag ??
              remoteDeployment?.cloudflareEtag ??
              (deployment.app.liveDeploymentId === remoteResult.currentDeploymentId
                ? deployment.app.liveCloudflareEtag
                : null);
            const winnerModifiedOn =
              remoteResult.currentModifiedOn ?? remoteDeployment?.cloudflareModifiedOn ?? null;

            if (remoteDeployment) {
              uow.update("deployment", remoteDeployment.id, (b) =>
                b
                  .set({
                    status: "succeeded",
                    updatedAt: now,
                    startedAt: remoteDeployment.startedAt ?? now,
                    completedAt: remoteDeployment.completedAt ?? now,
                    attemptCount: Math.max(remoteDeployment.attemptCount, 1),
                    errorCode: null,
                    errorMessage: null,
                    cloudflareEtag: winnerEtag,
                    cloudflareModifiedOn: winnerModifiedOn,
                  })
                  .check(),
              );
            }

            updateApp({
              liveDeploymentId: remoteResult.currentDeploymentId,
              liveCloudflareEtag: winnerEtag,
            });

            if (deployment.status === "succeeded") {
              return;
            }

            uow.update("deployment", deployment.id, (b) =>
              b
                .set({
                  status: "failed",
                  updatedAt: now,
                  startedAt: deployment.startedAt ?? now,
                  completedAt: now,
                  attemptCount: deployment.attemptCount + (remoteUploadAttempted ? 1 : 0),
                  errorCode: "DEPLOYMENT_SUPERSEDED",
                  errorMessage: `Deployment was superseded by '${supersededBy}'.`,
                })
                .check(),
            );
            return;
          }

          if (deployment.status === "succeeded") {
            updateApp();
            return;
          }

          const formatted = formatDeployError(remoteError);

          uow.update("deployment", deployment.id, (b) =>
            b
              .set({
                status: "failed",
                updatedAt: now,
                startedAt: deployment.startedAt ?? now,
                completedAt: now,
                attemptCount: deployment.attemptCount + (remoteUploadAttempted ? 1 : 0),
                errorCode: formatted.code,
                errorMessage: formatted.message,
              })
              .check(),
          );
          updateApp();
        })
        .execute();
    }),
  }))
  .providesBaseService(({ defineService, config }) => {
    return defineService({
      upsertApp: function (appId: string) {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", appId))),
          )
          .mutate(({ uow, retrieveResult: [existingApp] }) => {
            if (existingApp) {
              return buildAppSummary(existingApp, null);
            }

            const createdAt = new Date();
            const scriptName = resolveCloudflareScriptName(appId, config);
            const createdId = uow.create("app", {
              id: appId,
              scriptName,
              liveDeploymentId: null,
              liveCloudflareEtag: null,
              firstDeploymentLeaseId: null,
              createdAt,
              updatedAt: createdAt,
            });

            return {
              id: createdId.valueOf(),
              scriptName,
              latestDeployment: null,
              createdAt: createdAt.toISOString(),
              updatedAt: createdAt.toISOString(),
            };
          })
          .build();
      },
      queueDeployment: function (appId: string, request: CloudflareDeployRequest) {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow.findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", appId))),
          )
          .mutate(({ uow, retrieveResult: [existingApp] }) => {
            const now = new Date();
            const compatibilityDate = request.compatibilityDate ?? config.compatibilityDate;
            const compatibilityFlags = normalizeStringList(
              request.compatibilityFlags ?? config.compatibilityFlags,
            );
            const scriptName =
              existingApp?.scriptName ?? resolveCloudflareScriptName(appId, config);
            const sourceByteLength = textEncoder.encode(request.script.content).byteLength;
            const ensuredAppId =
              existingApp?.id ??
              uow.create("app", {
                id: appId,
                scriptName,
                liveDeploymentId: null,
                liveCloudflareEtag: null,
                firstDeploymentLeaseId: null,
                createdAt: now,
                updatedAt: now,
              });

            if (existingApp) {
              uow.update("app", existingApp.id, (b) => b.set({ updatedAt: now }).check());
            }

            const deploymentId = uow.create("deployment", {
              appId: ensuredAppId,
              status: "queued",
              format: SUPPORTED_DEPLOYMENT_FORMAT,
              entrypoint: request.script.entrypoint,
              scriptName,
              sourceCode: request.script.content,
              sourceByteLength,
              compatibilityDate,
              compatibilityFlags,
              attemptCount: 0,
              startedAt: null,
              completedAt: null,
              errorCode: null,
              errorMessage: null,
              cloudflareEtag: null,
              cloudflareModifiedOn: null,
              cloudflareResponse: null,
              createdAt: now,
              updatedAt: now,
            });
            const deploymentIdValue = deploymentId.valueOf();
            const expectedLiveEtag = existingApp?.liveCloudflareEtag ?? null;

            // The hook payload carries the immutable deploy snapshot plus the live etag it was
            // queued against so Cloudflare can enforce compare-and-swap updates for us.
            uow.triggerHook("deployWorker", {
              deploymentId: deploymentIdValue,
              appId: ensuredAppId.valueOf(),
              expectedLiveEtag,
              scriptName,
              entrypoint: request.script.entrypoint,
              moduleContent: request.script.content,
              compatibilityDate,
              compatibilityFlags,
            });

            return {
              id: deploymentIdValue,
              appId: ensuredAppId.valueOf(),
              scriptName,
              status: "queued" as const,
              format: SUPPORTED_DEPLOYMENT_FORMAT as "esmodule",
              entrypoint: request.script.entrypoint,
              sourceByteLength,
              compatibilityDate,
              compatibilityFlags,
              attemptCount: 0,
              queuedAt: now.toISOString(),
              startedAt: null,
              completedAt: null,
              errorCode: null,
              errorMessage: null,
              cloudflare: null,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            };
          })
          .build();
      },
      getDeployment: function (deploymentId: string) {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow.findFirst("deployment", (b) =>
              b
                .whereIndex("primary", (eb) => eb("id", "=", deploymentId))
                .joinOne("app", "app", (app) =>
                  app.onIndex("primary", (eb) => eb("id", "=", eb.parent("appId"))),
                ),
            ),
          )
          .transformRetrieve(([deployment]) => {
            return deployment?.app
              ? buildDeploymentDetail(deployment, deployment.app.id.valueOf())
              : null;
          })
          .build();
      },
      getAppState: function (appId: string) {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow
              .findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", appId)))
              .findFirst("deployment", (b) =>
                b
                  .whereIndex("idx_deployment_app_createdAt", (eb) => eb("appId", "=", appId))
                  .orderByIndex("idx_deployment_app_createdAt", "desc"),
              ),
          )
          .transformRetrieve(([app, latestDeployment]) => {
            return app
              ? {
                  ...buildAppSummary(app, latestDeployment),
                  liveDeploymentId: app.liveDeploymentId,
                  liveCloudflareEtag: app.liveCloudflareEtag,
                }
              : null;
          })
          .build();
      },
      listApps: function () {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow
              .find("app", (b) => b.whereIndex("primary"))
              .find("deployment", (b) =>
                b
                  .whereIndex("primary")
                  .joinOne("app", "app", (app) =>
                    app.onIndex("primary", (eb) => eb("id", "=", eb.parent("appId"))),
                  ),
              ),
          )
          .transformRetrieve(([apps, deployments]) => {
            const latestDeploymentsByAppId = new Map<string, (typeof deployments)[number]>();

            for (const deployment of deployments) {
              if (!deployment.app) {
                continue;
              }

              const deploymentAppId = deployment.app.id.valueOf();
              const existingDeployment = latestDeploymentsByAppId.get(deploymentAppId);

              if (
                !existingDeployment ||
                deployment.createdAt.getTime() > existingDeployment.createdAt.getTime()
              ) {
                latestDeploymentsByAppId.set(deploymentAppId, deployment);
              }
            }

            return apps
              .map((app) =>
                buildAppSummary(app, latestDeploymentsByAppId.get(app.id.valueOf()) ?? null),
              )
              .sort((left, right) => {
                const updatedAtCompare = right.updatedAt.localeCompare(left.updatedAt);
                if (updatedAtCompare !== 0) {
                  return updatedAtCompare;
                }

                return left.id.localeCompare(right.id);
              });
          })
          .build();
      },
      listAppDeployments: function (appId: string) {
        return this.serviceTx(cloudflareSchema)
          .retrieve((uow) =>
            uow
              .findFirst("app", (b) => b.whereIndex("primary", (eb) => eb("id", "=", appId)))
              .find("deployment", (b) =>
                b
                  .whereIndex("idx_deployment_app_createdAt", (eb) => eb("appId", "=", appId))
                  .orderByIndex("idx_deployment_app_createdAt", "desc"),
              ),
          )
          .transformRetrieve(([app, deployments]) => {
            if (!app) {
              return null;
            }

            return deployments.map((deployment) =>
              buildDeploymentSummary(deployment, app.id.valueOf()),
            );
          })
          .build();
      },
    });
  })
  .build();
