import type { FragnoRuntime } from "@fragno-dev/core";

import { cloudflareDatabaseAdapters } from "./cloudflare-database-adapters";
import { createCloudflareBackofficeObjectRegistry } from "./cloudflare-durable-object-factory";
import {
  createDurableObjectDatabaseAdapterScope,
  type BackofficeDatabaseAdapterFactory,
  type BackofficeDatabaseAdapterScope,
} from "./database-adapters";
import type { BackofficeObjectRegistry } from "./object-registry";

export type AuthEmailVerificationRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      publicBaseUrl: string;
    };

export type BackofficeRuntimeConfig = {
  docsPublicBaseUrl?: string;
  authEmailVerification: AuthEmailVerificationRuntimeConfig;
  bindings: {
    api: boolean;
    auth: boolean;
    automations: boolean;
    billing: boolean;
    telegram: boolean;
    otp: boolean;
    pi: boolean;
    resend: boolean;
    reson8: boolean;
    mcp: boolean;
    upload: boolean;
    github: boolean;
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
  authEmailVerification: parseAuthEmailVerificationRuntimeConfig({
    enabled: env.AUTH_EMAIL_VERIFICATION_ENABLED,
    publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
  }),
  bindings: {
    api: Boolean(env.API),
    auth: Boolean(env.AUTH),
    automations: Boolean(env.AUTOMATIONS),
    billing: Boolean(env.BILLING),
    telegram: Boolean(env.TELEGRAM),
    otp: Boolean(env.OTP),
    pi: Boolean(env.PI),
    resend: Boolean(env.RESEND),
    reson8: Boolean(env.RESON8),
    mcp: Boolean(env.MCP),
    upload: Boolean(env.UPLOAD),
    github: Boolean(env.GITHUB),
    githubWebhookRouter: Boolean(env.GITHUB_WEBHOOK_ROUTER),
    sandbox: Boolean(env.SANDBOX),
  },
});

const createOverriddenBackofficeRuntimeServices = (
  env: CloudflareEnv,
  overrides: BackofficeRuntimeServiceOverrides,
  options: CreateCloudflareBackofficeRuntimeServicesOptions = {},
): BackofficeRuntimeServices => {
  const config = overrides.config ?? createCloudflareBackofficeRuntimeConfig(env);
  const adapters = overrides.adapters ?? cloudflareDatabaseAdapters();

  return {
    objects: overrides.objects ?? createCloudflareBackofficeObjectRegistry(env),
    adapters: options.databaseScope ? adapters.forScope(options.databaseScope) : adapters,
    config,
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
