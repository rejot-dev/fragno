import type { GitHubWebhookRouter } from "workers/github-webhook-router.do";
import type { GitHub } from "workers/github.do";
import type { Mcp } from "workers/mcp.do";
import type { Otp } from "workers/otp.do";
import type { Pi } from "workers/pi.do";
import type { Resend } from "workers/resend.do";
import type { Reson8 } from "workers/reson8.do";
import type { Telegram } from "workers/telegram.do";
import type { Upload } from "workers/upload.do";

import type { Organization } from "@fragno-dev/auth";

import type { AutomationEvent, AutomationIngestResult } from "@/fragno/automation";
import type { DurableHookQueueOptions, DurableHookRepository } from "@/fragno/durable-hooks";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";
import type { SandboxInstanceStatus, SandboxInstanceSummary } from "@/sandbox/contracts";
import {
  AUTH_SINGLETON_ID,
  GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
  SANDBOX_REGISTRY_ORG_KEY_PREFIX,
} from "@/worker-runtime/durable-objects";

export type FetchObject = {
  fetch(request: Request): Promise<Response>;
};

export type AlarmableObject = {
  alarm?(): Promise<void>;
};

type DurableHookOptionsWithExtras = DurableHookQueueOptions & Record<string, unknown>;

type AwaitedMethodReturn<TObject, TKey extends keyof TObject> = TObject[TKey] extends (
  ...args: infer _Args
) => Promise<infer TResult>
  ? TResult
  : never;

export type DurableHookObject<TRepository = DurableHookRepository<DurableHookOptionsWithExtras>> = {
  getDurableHookRepository(...args: unknown[]): TRepository | Promise<TRepository>;
};

export type SingletonObject<TObject> = {
  get(): TObject;
};

export type OrgScopedObjects<TObject> = {
  forOrg(orgId: string): TObject;
};

export type NamedObjects<TObject> = {
  forName(name: string): TObject;
};

export type AdminConfigurableObject<TConfig = unknown> = {
  getAdminConfig(): Promise<TConfig>;
  resetAdminConfig(): Promise<TConfig>;
  setAdminConfig(...args: unknown[]): Promise<TConfig>;
};

export type AuthObject = FetchObject &
  AlarmableObject &
  DurableHookObject & {
    getAllOrganizations(): Promise<Organization[]>;
    getDevOrganizations(): Promise<
      Array<
        Pick<Organization, "id" | "name" | "slug" | "createdBy"> & {
          createdAt: Date;
          updatedAt: Date;
        }
      >
    >;
  };

export type AutomationsObject = FetchObject &
  AlarmableObject &
  DurableHookObject & {
    triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
    ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
  };

export type TelegramObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Telegram, "getAdminConfig">> & {
    getAutomationFile(input: { fileId: string }): Promise<TelegramAutomationFileMetadata>;
    downloadAutomationFile(input: { fileId: string }): Promise<Response>;
  };

export type OtpObject = FetchObject &
  AlarmableObject &
  DurableHookObject & {
    issueIdentityClaim(input: {
      orgId: string;
      actor: unknown;
      expiresInMinutes?: number;
      publicBaseUrl: string;
    }): Promise<{
      ok: true;
      url: string;
      otpId: string;
      externalId: string;
      code: string;
      type: string;
    }>;
    confirmIdentityClaim(input: unknown): Promise<AwaitedMethodReturn<Otp, "confirmIdentityClaim">>;
  };

export type PiObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Pi, "getAdminConfig">>;
export type ResendObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Resend, "getAdminConfig">>;
export type Reson8Object = FetchObject &
  AdminConfigurableObject<AwaitedMethodReturn<Reson8, "getAdminConfig">> & {
    getRealtimeOriginDiagnostic(
      origin: string,
    ): Promise<AwaitedMethodReturn<Reson8, "getRealtimeOriginDiagnostic">>;
  };
export type McpObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Mcp, "getAdminConfig">>;
export type UploadObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Upload, "getAdminConfig">>;
export type GitHubObject = FetchObject &
  AlarmableObject &
  DurableHookObject & {
    ensureAdminConfig(orgId: string): Promise<AwaitedMethodReturn<GitHub, "ensureAdminConfig">>;
    redeliverFailedInstallationWebhooks(installationId: string): Promise<void>;
  };
export type CloudflareWorkersObject = FetchObject & AlarmableObject & DurableHookObject;

export type SandboxRegistryObject = {
  getInstances(): Promise<SandboxInstanceSummary[]>;
  getInstance(id: string): Promise<SandboxInstanceSummary | null>;
  trackInstance(id: string): Promise<void>;
  untrackInstance(id: string): Promise<void>;
};

export type SandboxObject = {
  getRuntimeStatus(): Promise<{ status: SandboxInstanceStatus }>;
};

export type GitHubWebhookRouterObject = {
  getAdminConfig(
    orgId: string,
    origin: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "getAdminConfig">>;
  createInstallStatefulUrl(
    userId: string,
    orgId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "createInstallStatefulUrl">>;
  resolveInstallState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "resolveInstallState">>;
  consumeInstallState(
    input: unknown,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "consumeInstallState">>;
  setInstallationOrg(
    installationId: string,
    orgId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "setInstallationOrg">>;
  getInstallationOrg(installationId: string): Promise<string | null>;
  clearInstallationRouting(
    installationId: string,
  ): Promise<AwaitedMethodReturn<GitHubWebhookRouter, "clearInstallationRouting">>;
  getWebhookRouterSnapshot(): Promise<
    AwaitedMethodReturn<GitHubWebhookRouter, "getWebhookRouterSnapshot">
  >;
};

export type BackofficeObjectBindingName =
  | "AUTH"
  | "AUTOMATIONS"
  | "TELEGRAM"
  | "OTP"
  | "PI"
  | "RESEND"
  | "RESON8"
  | "MCP"
  | "UPLOAD"
  | "GITHUB"
  | "CLOUDFLARE_WORKERS"
  | "GITHUB_WEBHOOK_ROUTER"
  | "SANDBOX_REGISTRY"
  | "SANDBOX";

export type BackofficeObjectBinding<_TObject> = {
  name: BackofficeObjectBindingName;
};

export type BackofficeObjectFactory = {
  singleton<TObject>(binding: BackofficeObjectBinding<TObject>, name: string): TObject;
  org<TObject>(binding: BackofficeObjectBinding<TObject>, orgId: string): TObject;
  named<TObject>(binding: BackofficeObjectBinding<TObject>, name: string): TObject;
};

const binding = <TObject>(name: BackofficeObjectBindingName): BackofficeObjectBinding<TObject> => ({
  name,
});

const singleton = <TObject>(
  factory: BackofficeObjectFactory,
  binding: BackofficeObjectBinding<TObject>,
  name: string,
): SingletonObject<TObject> => ({
  get() {
    return factory.singleton(binding, name);
  },
});

const orgScoped = <TObject>(
  factory: BackofficeObjectFactory,
  binding: BackofficeObjectBinding<TObject>,
): OrgScopedObjects<TObject> => ({
  forOrg(orgId: string) {
    return factory.org(binding, orgId);
  },
});

const named = <TObject>(
  factory: BackofficeObjectFactory,
  binding: BackofficeObjectBinding<TObject>,
): NamedObjects<TObject> => ({
  forName(name: string) {
    return factory.named(binding, name);
  },
});

export const createBackofficeObjectRegistry = (factory: BackofficeObjectFactory) => ({
  auth: singleton(factory, binding<AuthObject>("AUTH"), AUTH_SINGLETON_ID),

  automations: orgScoped(factory, binding<AutomationsObject>("AUTOMATIONS")),
  telegram: orgScoped(factory, binding<TelegramObject>("TELEGRAM")),
  otp: orgScoped(factory, binding<OtpObject>("OTP")),
  pi: orgScoped(factory, binding<PiObject>("PI")),
  resend: orgScoped(factory, binding<ResendObject>("RESEND")),
  reson8: orgScoped(factory, binding<Reson8Object>("RESON8")),
  mcp: orgScoped(factory, binding<McpObject>("MCP")),
  upload: orgScoped(factory, binding<UploadObject>("UPLOAD")),
  github: orgScoped(factory, binding<GitHubObject>("GITHUB")),
  cloudflareWorkers: orgScoped(factory, binding<CloudflareWorkersObject>("CLOUDFLARE_WORKERS")),

  githubWebhookRouter: singleton(
    factory,
    binding<GitHubWebhookRouterObject>("GITHUB_WEBHOOK_ROUTER"),
    GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
  ),

  sandboxRegistry: {
    forOrg(orgId: string) {
      return factory.named(
        binding<SandboxRegistryObject>("SANDBOX_REGISTRY"),
        `${SANDBOX_REGISTRY_ORG_KEY_PREFIX}${orgId}`,
      );
    },
  },

  sandbox: named(factory, binding<SandboxObject>("SANDBOX")),
});

export type BackofficeObjectRegistry = ReturnType<typeof createBackofficeObjectRegistry>;
