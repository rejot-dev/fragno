import type { Api } from "workers/api.do";
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

import type {
  AutomationEvent,
  AutomationEventActor,
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxProvider,
  StarterAutomationRoutesSeedResult,
} from "@/fragno/automation";
import type { DurableHookQueueOptions, DurableHookRepository } from "@/fragno/durable-hooks";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";
import type { SandboxInstanceStatus } from "@/sandbox/contracts";

import type { BackofficeContextScope } from "./context";

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

type ScopedObjects<TObject> = {
  singleton(): TObject;
  "for"(scope: BackofficeContextScope): TObject;
  forOrg(orgId: string): TObject;
  forName(name: string): TObject;
  forUser(input: { userId: string }): TObject;
  forProject(input: { orgId: string; projectId: string }): TObject;
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

export type ApiObject = FetchObject &
  AlarmableObject &
  DurableHookObject &
  AdminConfigurableObject<AwaitedMethodReturn<Api, "getAdminConfig">>;

export type AutomationsObject = FetchObject &
  AlarmableObject &
  DurableHookObject & {
    triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
    ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult>;
    seedStarterAutomationRoutes(input?: {
      scope?: BackofficeContextScope;
    }): Promise<StarterAutomationRoutesSeedResult>;
    resolveProjectForExecution(input: {
      projectId?: string;
      slug?: string;
    }): Promise<AutomationProjectExecutionTarget | null>;
    listSandboxInstances(input?: {
      provider?: SandboxProvider;
      limit?: number;
    }): Promise<SandboxInstanceRecord[]>;
    getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null>;
    requestSandboxInstance(
      input: SandboxInstanceRequestInput & { ownerScope?: BackofficeContextScope },
    ): Promise<SandboxInstanceRecord>;
    requestSandboxInstanceStop(input: {
      id: string;
      ownerScope?: BackofficeContextScope;
    }): Promise<SandboxInstanceRecord | null>;
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

type SandboxObject = {
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
  | "API"
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
  | "SANDBOX";

export type BackofficeObjectBinding<_TObject> = {
  name: BackofficeObjectBindingName;
};

export type BackofficeObjectScope =
  | { kind: "singleton" }
  | { kind: "org"; orgId: string }
  | { kind: "named"; name: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

export type BackofficeObjectAddress = {
  binding: BackofficeObjectBindingName;
  scope: BackofficeObjectScope;
};

export type BackofficeObjectScopeKind = BackofficeObjectScope["kind"];

export const backofficeObjectScopePolicy = {
  API: ["org", "user", "project"],
  AUTH: ["singleton"],

  AUTOMATIONS: ["singleton", "org", "user", "project"],

  TELEGRAM: ["org"],
  OTP: ["org"],
  RESEND: ["org"],
  RESON8: ["org"],
  MCP: ["org", "user", "project"],
  UPLOAD: ["org", "user", "project"],
  GITHUB: ["org"],
  CLOUDFLARE_WORKERS: ["org"],

  PI: ["org"],

  GITHUB_WEBHOOK_ROUTER: ["singleton"],

  SANDBOX: ["named"],
} satisfies Record<BackofficeObjectBindingName, readonly BackofficeObjectScopeKind[]>;

export const assertBackofficeObjectAddressAllowed = (address: BackofficeObjectAddress) => {
  const allowedScopes: readonly BackofficeObjectScopeKind[] =
    backofficeObjectScopePolicy[address.binding];
  if (!allowedScopes.includes(address.scope.kind)) {
    throw new Error(
      `Backoffice object ${address.binding} cannot be instantiated with ${address.scope.kind} scope. Allowed scopes: ${allowedScopes.join(", ")}.`,
    );
  }
};

export type BackofficeObjectFactory = {
  get<TObject>(
    binding: BackofficeObjectBinding<TObject>,
    address: BackofficeObjectAddress,
  ): TObject;
};

const binding = <TObject>(name: BackofficeObjectBindingName): BackofficeObjectBinding<TObject> => ({
  name,
});

const validateScopeValue = (label: string, value: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Backoffice object address requires a non-empty ${label}.`);
  }

  return normalized;
};

const encodeScopeValue = (label: string, value: string): string =>
  encodeURIComponent(validateScopeValue(label, value));

export const singleton = (): BackofficeObjectScope => ({
  kind: "singleton",
});

export const org = (orgId: string): BackofficeObjectScope => ({
  kind: "org",
  orgId: validateScopeValue("org id", orgId),
});

export const named = (name: string): BackofficeObjectScope => ({
  kind: "named",
  name: validateScopeValue("name", name),
});

export const user = (input: { userId: string }): BackofficeObjectScope => ({
  kind: "user",
  userId: validateScopeValue("user id", input.userId),
});

export const project = (input: { orgId: string; projectId: string }): BackofficeObjectScope => ({
  kind: "project",
  orgId: validateScopeValue("org id", input.orgId),
  projectId: validateScopeValue("project id", input.projectId),
});

// Operator note: this v1 encoder is a full Durable Object identity reset. Existing
// state stored under legacy raw names is intentionally not discovered by this model.
export const encodeBackofficeObjectAddress = (address: BackofficeObjectAddress): string => {
  switch (address.scope.kind) {
    case "singleton":
      return "v1:singleton";
    case "org":
      return `v1:org:${encodeScopeValue("org id", address.scope.orgId)}`;
    case "named":
      return `v1:named:${encodeScopeValue("name", address.scope.name)}`;
    case "user":
      return ["v1", "user", encodeScopeValue("user id", address.scope.userId)].join(":");
    case "project":
      return [
        "v1",
        "project",
        encodeScopeValue("org id", address.scope.orgId),
        encodeScopeValue("project id", address.scope.projectId),
      ].join(":");
  }
};

export const objectAddressToActor = (address: BackofficeObjectAddress): AutomationEventActor => ({
  scope: "internal",
  type: "object",
  id: `${address.binding}/${encodeBackofficeObjectAddress(address)}`,
  role: "delegate",
});

const objectAddress = (
  objectBinding: BackofficeObjectBinding<unknown>,
  scope: BackofficeObjectScope,
): BackofficeObjectAddress => ({
  binding: objectBinding.name,
  scope,
});

const scoped = <TObject>(
  factory: BackofficeObjectFactory,
  objectBinding: BackofficeObjectBinding<TObject>,
): ScopedObjects<TObject> => ({
  singleton() {
    return factory.get(objectBinding, objectAddress(objectBinding, singleton()));
  },
  for(scope: BackofficeContextScope) {
    switch (scope.kind) {
      case "system":
        return factory.get(objectBinding, objectAddress(objectBinding, singleton()));
      case "org":
        return factory.get(objectBinding, objectAddress(objectBinding, org(scope.orgId)));
      case "user":
        return factory.get(
          objectBinding,
          objectAddress(objectBinding, user({ userId: scope.userId })),
        );
      case "project":
        return factory.get(
          objectBinding,
          objectAddress(objectBinding, project({ orgId: scope.orgId, projectId: scope.projectId })),
        );
    }
  },
  forOrg(orgId: string) {
    return factory.get(objectBinding, objectAddress(objectBinding, org(orgId)));
  },
  forName(name: string) {
    return factory.get(objectBinding, objectAddress(objectBinding, named(name)));
  },
  forUser(input: { userId: string }) {
    return factory.get(objectBinding, objectAddress(objectBinding, user(input)));
  },
  forProject(input: { orgId: string; projectId: string }) {
    return factory.get(objectBinding, objectAddress(objectBinding, project(input)));
  },
});

export const createBackofficeObjectRegistry = (factory: BackofficeObjectFactory) => ({
  api: scoped(factory, binding<ApiObject>("API")),
  auth: scoped(factory, binding<AuthObject>("AUTH")),

  automations: scoped(factory, binding<AutomationsObject>("AUTOMATIONS")),
  telegram: scoped(factory, binding<TelegramObject>("TELEGRAM")),
  otp: scoped(factory, binding<OtpObject>("OTP")),
  pi: scoped(factory, binding<PiObject>("PI")),
  resend: scoped(factory, binding<ResendObject>("RESEND")),
  reson8: scoped(factory, binding<Reson8Object>("RESON8")),
  mcp: scoped(factory, binding<McpObject>("MCP")),
  upload: scoped(factory, binding<UploadObject>("UPLOAD")),
  github: scoped(factory, binding<GitHubObject>("GITHUB")),
  cloudflareWorkers: scoped(factory, binding<CloudflareWorkersObject>("CLOUDFLARE_WORKERS")),

  githubWebhookRouter: scoped(factory, binding<GitHubWebhookRouterObject>("GITHUB_WEBHOOK_ROUTER")),

  sandbox: scoped(factory, binding<SandboxObject>("SANDBOX")),
});

export type BackofficeObjectRegistry = ReturnType<typeof createBackofficeObjectRegistry>;
