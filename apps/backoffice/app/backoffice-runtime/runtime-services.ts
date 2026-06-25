import type { FragnoRuntime } from "@fragno-dev/core";

import { cloudflareDatabaseAdapters } from "./cloudflare-database-adapters";
import { createCloudflareBackofficeObjectRegistry } from "./cloudflare-durable-object-factory";
import {
  createDurableObjectDatabaseAdapterScope,
  type BackofficeDatabaseAdapterFactory,
  type BackofficeDatabaseAdapterScope,
} from "./database-adapters";
import type { BackofficeObjectRegistry } from "./object-registry";

export type BackofficeRuntimeConfig = {
  docsPublicBaseUrl?: string;
  bindings: {
    api: boolean;
    auth: boolean;
    automations: boolean;
    telegram: boolean;
    otp: boolean;
    pi: boolean;
    resend: boolean;
    reson8: boolean;
    mcp: boolean;
    upload: boolean;
    github: boolean;
    cloudflareWorkers: boolean;
    githubWebhookRouter: boolean;
    sandbox: boolean;
  };
};

export type BackofficeRuntimeServices = {
  objects: BackofficeObjectRegistry;
  adapters: BackofficeDatabaseAdapterFactory;
  config: BackofficeRuntimeConfig;
  fragnoRuntime?: FragnoRuntime;
};

type BackofficeRuntimeServiceOverrides = Partial<
  Pick<BackofficeRuntimeServices, "objects" | "adapters" | "config">
>;

type CreateCloudflareBackofficeRuntimeServicesOptions = {
  databaseScope?: BackofficeDatabaseAdapterScope;
};

const createCloudflareBackofficeRuntimeConfig = (env: CloudflareEnv): BackofficeRuntimeConfig => ({
  ...(env.DOCS_PUBLIC_BASE_URL?.trim()
    ? { docsPublicBaseUrl: env.DOCS_PUBLIC_BASE_URL.trim() }
    : {}),
  bindings: {
    api: Boolean(env.API),
    auth: Boolean(env.AUTH),
    automations: Boolean(env.AUTOMATIONS),
    telegram: Boolean(env.TELEGRAM),
    otp: Boolean(env.OTP),
    pi: Boolean(env.PI),
    resend: Boolean(env.RESEND),
    reson8: Boolean(env.RESON8),
    mcp: Boolean(env.MCP),
    upload: Boolean(env.UPLOAD),
    github: Boolean(env.GITHUB),
    cloudflareWorkers: Boolean(env.CLOUDFLARE_WORKERS),
    githubWebhookRouter: Boolean(env.GITHUB_WEBHOOK_ROUTER),
    sandbox: Boolean(env.SANDBOX),
  },
});

const createOverriddenBackofficeRuntimeServices = (
  env: CloudflareEnv,
  overrides: BackofficeRuntimeServiceOverrides,
  options: CreateCloudflareBackofficeRuntimeServicesOptions = {},
): BackofficeRuntimeServices => {
  const adapters = overrides.adapters ?? cloudflareDatabaseAdapters();

  return {
    objects: overrides.objects ?? createCloudflareBackofficeObjectRegistry(env),
    adapters: options.databaseScope ? adapters.forScope(options.databaseScope) : adapters,
    config: overrides.config ?? createCloudflareBackofficeRuntimeConfig(env),
  };
};

export const createCloudflareBackofficeRuntimeServices = (
  env: CloudflareEnv,
  options: CreateCloudflareBackofficeRuntimeServicesOptions = {},
): BackofficeRuntimeServices => createOverriddenBackofficeRuntimeServices(env, {}, options);

export const createCloudflareDurableObjectRuntimeServices = (
  env: CloudflareEnv,
  state: DurableObjectState,
): BackofficeRuntimeServices =>
  createCloudflareBackofficeRuntimeServices(env, {
    databaseScope: createDurableObjectDatabaseAdapterScope(state),
  });
