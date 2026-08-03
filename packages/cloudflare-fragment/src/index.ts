import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";

import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { createBrowserRunCaptureClient } from "./browser-run/client";
import { browserRunRoutesFactory } from "./browser-run/routes";
import { cloudflareFragmentDefinition, type CloudflareFragmentConfig } from "./definition";
import { cloudflareRoutesFactory } from "./routes";

const routes = [cloudflareRoutesFactory, browserRunRoutesFactory] as const;

export function createCloudflareFragment(
  config: CloudflareFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(cloudflareFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export function createCloudflareFragmentClients(fragnoConfig: FragnoPublicClientConfig = {}) {
  const builder = createClientBuilder(cloudflareFragmentDefinition, fragnoConfig, routes);
  const { fetcher, defaultOptions } = builder.getFetcher();
  const captureBrowserRun = createBrowserRunCaptureClient({
    buildUrl: (path) => builder.buildUrl(path),
    fetcher,
    defaultOptions,
  });

  return {
    useApps: builder.createHook("/apps"),
    useApp: builder.createHook("/apps/:appId"),
    useAppDeployments: builder.createHook("/apps/:appId/deployments"),
    useDeployment: builder.createHook("/deployments/:deploymentId"),
    useBrowserRunExtract: builder.createMutator("POST", "/browser-run/extract"),
    captureBrowserRun,
    useBrowserRunCrawl: builder.createMutator("POST", "/browser-run/crawl"),
    useQueueDeployment: builder.createMutator(
      "POST",
      "/apps/:appId/deployments",
      (invalidate, params) => {
        const appId = params.pathParams.appId;
        if (!appId) {
          return;
        }

        invalidate("GET", "/apps", {});
        invalidate("GET", "/apps/:appId", { pathParams: { appId } });
        invalidate("GET", "/apps/:appId/deployments", { pathParams: { appId } });
      },
    ),
  };
}

export { cloudflareFragmentDefinition } from "./definition";
export { createBrowserRunCaptureClient } from "./browser-run/client";
export type { BrowserRunCaptureClient } from "./browser-run/client";
export {
  browserRunCaptureInputSchema,
  browserRunCrawlActionInputSchema,
  browserRunCrawlActionResultSchema,
  browserRunExtractInputSchema,
  browserRunExtractResultSchema,
} from "./browser-run/contracts";
export type {
  BrowserRunCaptureInput,
  BrowserRunCrawlActionInput,
  BrowserRunCrawlActionResult,
  BrowserRunExtractInput,
  BrowserRunExtractResult,
} from "./browser-run/contracts";
export { createBrowserRunQuickActions } from "./browser-run/quick-actions";
export type {
  BrowserRunAccessibilityTreeInput,
  BrowserRunContentInput,
  BrowserRunCrawlInput,
  BrowserRunJsonInput,
  BrowserRunLinksInput,
  BrowserRunMarkdownInput,
  BrowserRunPdfInput,
  BrowserRunQuickActions,
  BrowserRunScrapeInput,
  BrowserRunScreenshotInput,
  BrowserRunSnapshotInput,
} from "./browser-run/quick-actions";
export { browserRunRoutesFactory } from "./browser-run/routes";
export { cloudflareRoutesFactory } from "./routes";
export { cloudflareSchema } from "./schema";
export {
  DEFAULT_DEPLOYMENT_ENTRYPOINT,
  SUPPORTED_DEPLOYMENT_FORMAT,
  cloudflareAppListSchema,
  cloudflareAppStateSchema,
  cloudflareAppSummarySchema,
  cloudflareDeployRequestSchema,
  cloudflareDeployScriptSchema,
  cloudflareDeploymentDetailSchema,
  cloudflareDeploymentListSchema,
  cloudflareDeploymentStatusSchema,
  cloudflareDeploymentSummarySchema,
} from "./contracts";
export {
  DEFAULT_SCRIPT_NAME_SEPARATOR,
  DEFAULT_MAX_SCRIPT_NAME_LENGTH,
  resolveCloudflareScriptName,
} from "./script-name";
export {
  createCloudflareApiClient,
  buildCloudflareScriptTags,
  deployCloudflareWorker,
  getCloudflareCurrentDeployment,
  getCloudflareScriptState,
  getCloudflareApiError,
  listCloudflareScriptTags,
  reconcileCloudflareWorkerDeployment,
  resolveCloudflareDispatchNamespaceName,
} from "./cloudflare-api";
export {
  DEFAULT_DEPLOYMENT_TAG_PREFIX,
  buildCloudflareAppTag,
  buildCloudflareDeploymentTag,
  findCloudflareAppTag,
  findCloudflareDeploymentTag,
  getCloudflareAppIdFromTag,
  getCloudflareDeploymentIdFromTag,
  normalizeCloudflareDeploymentTagPrefix,
  sanitizeCloudflareTag,
} from "./deployment-tag";
export type {
  CloudflareFragmentConfig,
  CloudflareWorkersForPlatformsConfig,
  DeployWorkerHookInput,
} from "./definition";
export type {
  CloudflareApiClient,
  CloudflareCurrentDeployment,
  CloudflareDispatchNamespaceBinding,
  CloudflareDispatchNamespaceDescriptor,
  CloudflareDispatcherConfig,
  CloudflareDeploymentReconciliationResult,
  CloudflareScriptState,
  CloudflareScriptUpdateParams,
  CloudflareScriptUpdateResponse,
  DeployCloudflareWorkerInput,
  ReconcileCloudflareWorkerDeploymentInput,
} from "./cloudflare-api";
export type {
  CloudflareAppList,
  CloudflareAppState,
  CloudflareAppSummary,
  CloudflareDeployRequest,
  CloudflareDeploymentDetail,
  CloudflareDeploymentList,
  CloudflareDeploymentStatus,
  CloudflareDeploymentSummary,
} from "./contracts";
export type { FragnoRouteConfig } from "@fragno-dev/core";
