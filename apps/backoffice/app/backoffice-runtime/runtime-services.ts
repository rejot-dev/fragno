import { SANDBOX_BACKOFFICE_ORIGIN } from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import type { WorkerTypeChecker } from "@fragno-dev/codemode/compiler/compile-worker";
import { createWorkerTypeCheckerServiceClient } from "@fragno-dev/codemode/compiler/compiler-service-client";
import type { CodemodeExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import {
  codemodeExecutionService,
  createCodemodeServiceExecutor,
} from "@fragno-dev/codemode/remote/codemode-service-executor";
import type { FragmentDurableObjectHostOperations } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type { FragnoRuntime } from "@fragno-dev/core";

import { createAppInstallationAuthorityResolver } from "@/fragno/app-installations/authority";
import { createAutomationRouteAuthorityResolver } from "@/fragno/automation/authority";
import { createReson8Server, type Reson8Fragment } from "@/fragno/reson8";

import {
  createBackofficeAuthorityResolver,
  type BackofficeAuthorityResolver,
} from "./authority-resolver";
import { cloudflareDatabaseAdapters } from "./cloudflare-database-adapters";
import { createCloudflareBackofficeObjectRegistry } from "./cloudflare-durable-object-factory";
import { createControlPlaneAuthorityResolver } from "./control-plane-authority-resolver";
import {
  createDurableObjectDatabaseAdapterScope,
  type BackofficeDatabaseAdapterFactory,
  type BackofficeDatabaseAdapterScope,
} from "./database-adapters";
import { noopBackofficeKernelObserver, type BackofficeKernelObserver } from "./kernel";
import type { BackofficeObjectRegistry } from "./object-registry";

export type AuthEmailVerificationRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      publicBaseUrl: string;
    };

export type BackofficeRuntimeConfig = {
  docsPublicBaseUrl?: string;
  /** Where sandbox commands reach Backoffice file links, or null when they cannot. */
  sandboxBackofficeBaseUrl: string | null;
  /** Whether the sandbox host runs containers; local servers started without them do not. */
  sandboxContainers: boolean;
  authEmailVerification: AuthEmailVerificationRuntimeConfig;
  /** Whether people need an access code to create their own accounts. */
  signUpAccessCodesRequired: boolean;
  /** Print outgoing email to the terminal, and skip delivery while Resend is unconfigured. */
  localEmailLog: boolean;
  /** Whether PiManager runs Workers AI models, through the `AI` binding. */
  workersAi: boolean;
  bindings: {
    api: boolean;
    auth: boolean;
    automations: boolean;
    piManager: boolean;
    billing: boolean;
    marketplace: boolean;
    telegram: boolean;
    otp: boolean;
    resend: boolean;
    mcp: boolean;
    projectConnector: boolean;
    upload: boolean;
    blobs: boolean;
    github: boolean;
    githubWebhookRouter: boolean;
    cloudflare: boolean;
    sandbox: boolean;
  };
};

export type BackofficeFragmentHostOperations = FragmentDurableObjectHostOperations<unknown>;

export type BackofficeRuntimeServices = {
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
  config: BackofficeRuntimeConfig;
  authorityResolver: BackofficeAuthorityResolver;
  kernelObserver: BackofficeKernelObserver;
  codemodeExecutor: CodemodeExecutor | null;
  workerTypeChecker: WorkerTypeChecker | null;
  /** Speech-to-text under the platform key; null when the deployment has none. */
  reson8: Reson8Fragment | null;
  /**
   * Reaches the public internet for `web.download`, or null where connections cannot be kept to
   * public addresses. Scenarios serve fake sites through it.
   */
  webFetch: typeof fetch | null;
  fragnoRuntime?: FragnoRuntime;
};

type CreateCloudflareBackofficeRuntimeServicesOptions = {
  databaseScope?: BackofficeDatabaseAdapterScope;
  kernelObserver?: BackofficeKernelObserver;
};

export const parseBooleanEnv = (name: string, value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  throw new Error(`${name} must be one of: true, false, 1, 0.`);
};

const parsePublicHttpUrl = (name: string, value: string | undefined): string => {
  const configuredValue = value?.trim();
  if (!configuredValue) {
    throw new Error(`${name} must be configured as an absolute http or https URL.`);
  }

  let url: URL;
  try {
    url = new URL(configuredValue);
  } catch (cause) {
    throw new Error(`${name} must be configured as an absolute http or https URL.`, { cause });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be configured as an absolute http or https URL.`);
  }

  return url.toString();
};

/** Deployments admit new accounts only with an access code unless they opt out. */
export const parseSignUpAccessCodesRequired = (value: string | undefined): boolean =>
  value === undefined ? true : parseBooleanEnv("SIGN_UP_ACCESS_CODES_REQUIRED", value);

export const parseAuthEmailVerificationRuntimeConfig = (input: {
  enabled: string | undefined;
  publicBaseUrl: string | undefined;
}): AuthEmailVerificationRuntimeConfig => {
  if (!parseBooleanEnv("AUTH_EMAIL_VERIFICATION_ENABLED", input.enabled)) {
    return { enabled: false };
  }

  return {
    enabled: true,
    publicBaseUrl: parsePublicHttpUrl("DOCS_PUBLIC_BASE_URL", input.publicBaseUrl),
  };
};

const createCloudflareBackofficeRuntimeConfig = (env: CloudflareEnv): BackofficeRuntimeConfig => ({
  ...(env.DOCS_PUBLIC_BASE_URL?.trim()
    ? { docsPublicBaseUrl: env.DOCS_PUBLIC_BASE_URL.trim() }
    : {}),
  // SANDBOX binds the bridge's Sandbox, whose containers intercept this origin into this deployment.
  sandboxBackofficeBaseUrl: `${SANDBOX_BACKOFFICE_ORIGIN}/`,
  sandboxContainers: parseBooleanEnv("SANDBOX_CONTAINERS", env.SANDBOX_CONTAINERS),
  authEmailVerification: parseAuthEmailVerificationRuntimeConfig({
    enabled: env.AUTH_EMAIL_VERIFICATION_ENABLED,
    publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
  }),
  signUpAccessCodesRequired: parseSignUpAccessCodesRequired(env.SIGN_UP_ACCESS_CODES_REQUIRED),
  localEmailLog: parseBooleanEnv("LOCAL_EMAIL_LOG", env.LOCAL_EMAIL_LOG),
  workersAi: Boolean(env.AI),
  bindings: {
    api: Boolean(env.API),
    auth: Boolean(env.AUTH),
    automations: Boolean(env.AUTOMATIONS),
    piManager: Boolean(env.PI_MANAGER),
    billing: Boolean(env.BILLING),
    marketplace: Boolean(env.MARKETPLACE),
    telegram: Boolean(env.TELEGRAM),
    otp: Boolean(env.OTP),
    resend: Boolean(env.RESEND),
    mcp: Boolean(env.MCP),
    projectConnector: Boolean(env.PROJECT_CONNECTOR),
    upload: Boolean(env.UPLOAD),
    blobs: Boolean(env.BLOBS),
    github: Boolean(env.GITHUB),
    githubWebhookRouter: Boolean(env.GITHUB_WEBHOOK_ROUTER),
    cloudflare: Boolean(env.CLOUDFLARE),
    sandbox: Boolean(env.SANDBOX),
  },
});

/** Resolves authority from the Auth, Automations and App Installations objects. */
export function createObjectsAuthorityResolver(
  objects: BackofficeObjectRegistry,
  now: () => number,
): BackofficeAuthorityResolver {
  return createControlPlaneAuthorityResolver({
    resolver: createAppInstallationAuthorityResolver({
      resolver: createAutomationRouteAuthorityResolver({
        fallbackResolver: createBackofficeAuthorityResolver(
          {
            getUserAuthorityFacts: async (input) =>
              await objects.auth.singleton().commands.getUserAuthorityFacts(input),
            findAdministeredMember: async (input) =>
              await objects.auth.singleton().commands.findAdministeredMember(input),
          },
          { now },
        ),
        lookupRoute: async ({ scope, routeId }) =>
          await objects.automations.for(scope).commands.getRouteForAuthority({ id: routeId }),
      }),
      installations: {
        getInstallation: async ({ owner, appId }) =>
          await objects.appInstallations.for(owner).commands.getInstallation({ appId }),
      },
    }),
    auth: {
      getUserOrganizationAuthorityFacts: async (input) =>
        await objects.auth.singleton().commands.getUserOrganizationAuthorityFacts(input),
    },
  });
}

export const createCloudflareBackofficeRuntimeServices = (
  env: CloudflareEnv,
  options: CreateCloudflareBackofficeRuntimeServicesOptions = {},
): BackofficeRuntimeServices => {
  const adapters = cloudflareDatabaseAdapters();
  const objects = createCloudflareBackofficeObjectRegistry(env);

  return {
    objects,
    adapters: options.databaseScope ? adapters.forScope(options.databaseScope) : adapters,
    config: createCloudflareBackofficeRuntimeConfig(env),
    authorityResolver: createObjectsAuthorityResolver(objects, Date.now),
    kernelObserver: options.kernelObserver ?? noopBackofficeKernelObserver,
    codemodeExecutor: env.CODEMODE_EXECUTOR
      ? createCodemodeServiceExecutor(codemodeExecutionService(env.CODEMODE_EXECUTOR))
      : null,
    workerTypeChecker: env.CODEMODE_COMPILER
      ? createWorkerTypeCheckerServiceClient(env.CODEMODE_COMPILER)
      : null,
    reson8: env.RESON8_API_KEY ? createReson8Server(env.RESON8_API_KEY) : null,
    // Deployed Workers cannot connect to private addresses, so their fetch stays public.
    webFetch: async (input, init) => await fetch(input, init),
  };
};

export const createCloudflareDurableObjectRuntimeServices = (
  env: CloudflareEnv,
  state: DurableObjectState,
): BackofficeRuntimeServices =>
  createCloudflareBackofficeRuntimeServices(env, {
    databaseScope: createDurableObjectDatabaseAdapterScope(state),
  });
