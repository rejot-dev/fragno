import { createBackofficeAuthorityResolver } from "../authority-resolver";
import type { BackofficeRuntimeEnv } from "../backoffice-runtime-env";
import { cloudflareDatabaseAdapters } from "../cloudflare-database-adapters";
import { noopBackofficeKernelObserver } from "../kernel";
import {
  parseAuthEmailVerificationRuntimeConfig,
  parseSignUpInvitationsEnabled,
  type BackofficeRuntimeServices,
} from "../runtime-services";
import {
  createGraftBackofficeObjectRegistry,
  type GraftBackofficeObjectResolver,
} from "./graft-object-registry";
import { createNodeBackofficeRuntimeConfiguration } from "./node-runtime-env";

/** Only configuration crosses worker boundaries; clients and functions are constructed locally. */
export type GraftBackofficeConfiguration = {
  env: Omit<BackofficeRuntimeEnv, "codemode"> & {
    AUTH_ACCESS_TOKEN_SECRET: string;
    BACKOFFICE_INTERNAL_REQUEST_SECRET: string;
  };
  bridge: { url: string; apiKey: string } | null;
};

/** The HTTP process and each object worker construct their own registry and service clients. */
export function createGraftBackofficeRuntimeServices(options: {
  configuration: GraftBackofficeConfiguration;
  resolve: GraftBackofficeObjectResolver;
  nowEpochMs(this: void): number;
}): {
  env: BackofficeRuntimeEnv;
  services: BackofficeRuntimeServices;
  createSandboxProviders: ReturnType<
    typeof createNodeBackofficeRuntimeConfiguration
  >["createSandboxProviders"];
} {
  const bridge = options.configuration.bridge;
  const configuration =
    bridge === null
      ? {
          runtimeEnv: { ...options.configuration.env, codemode: null },
          workerTypeChecker: null,
          createSandboxProviders: () => ({}),
        }
      : createNodeBackofficeRuntimeConfiguration({
          env: options.configuration.env,
          bridgeUrl: bridge.url,
          bridgeApiKey: bridge.apiKey,
        });
  const env = configuration.runtimeEnv;
  const objects = createGraftBackofficeObjectRegistry({
    resolve: options.resolve,
    env,
    nowEpochMs: options.nowEpochMs,
  });
  return {
    env,
    createSandboxProviders: configuration.createSandboxProviders,
    services: {
      objects,
      adapters: cloudflareDatabaseAdapters(),
      config: {
        ...(env.DOCS_PUBLIC_BASE_URL ? { docsPublicBaseUrl: env.DOCS_PUBLIC_BASE_URL } : {}),
        authEmailVerification: parseAuthEmailVerificationRuntimeConfig({
          enabled: env.AUTH_EMAIL_VERIFICATION_ENABLED,
          publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
        }),
        signUpInvitationsEnabled: parseSignUpInvitationsEnabled({
          enabled: env.SIGN_UP_INVITATIONS_ENABLED,
          publicBaseUrl: env.DOCS_PUBLIC_BASE_URL,
          accountCreationAvailable: true,
        }),
        bindings: {
          api: true,
          auth: true,
          automations: true,
          billing: true,
          marketplace: true,
          telegram: true,
          otp: true,
          resend: true,
          reson8: true,
          mcp: true,
          projectConnector: true,
          upload: true,
          github: true,
          githubWebhookRouter: true,
          cloudflare: true,
          sandbox: bridge !== null,
        },
      },
      authorityResolver: createBackofficeAuthorityResolver(
        {
          getUserAuthorityFacts: (input) =>
            objects.auth.singleton().commands.getUserAuthorityFacts(input),
        },
        { now: options.nowEpochMs },
      ),
      kernelObserver: noopBackofficeKernelObserver,
      codemodeEnv: env.codemode,
      workerTypeChecker: configuration.workerTypeChecker,
    },
  };
}
