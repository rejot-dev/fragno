import { DurableObject } from "cloudflare:workers";

import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { bytesToHex } from "@/lib/crypto";

import { maskSecret, resolveGitHubConfig, resolveWebhookUrl } from "./github.shared";

type AdminConfigResponse = {
  configured: boolean;
  missing: string[];
  error: string | null;
  app?: {
    appId: string;
    appSlug: string;
    privateKeySource: "env" | "file";
    webhookSecretPreview: string;
    webhookUrl: string;
    installUrl: string;
    docsUrl: string;
  };
};

type StoredInstallState = {
  userId: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
};

type StoredInstallationClaimState = StoredInstallState & {
  returnTo: string;
  completion?: unknown;
};

type CreateInstallUrlResult =
  | {
      ok: true;
      installUrl: string;
      expiresAt: number;
    }
  | {
      ok: false;
      message: string;
      missing?: string[];
      error?: string | null;
    };

type ConsumeInstallStateInput = {
  state: string;
  userId: string;
  installationId: string;
};

type ResolveInstallStateInput = {
  state: string;
  userId: string;
};

type StoreInstallationClaimStateInput = {
  state: string;
  userId: string;
  orgId: string;
  returnTo: string;
  expiresAt: number;
};

type StoreInstallationClaimCompletionInput = {
  state: string;
  userId: string;
  completion: unknown;
};

type InstallStateResolutionResult =
  | {
      ok: true;
      orgId: string;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

type InstallationClaimStateResolutionResult =
  | {
      ok: true;
      orgId: string;
      returnTo: string;
      completion: unknown;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

type ConsumeInstallStateResult =
  | {
      ok: true;
      installationId: string;
      orgId: string;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

const INSTALL_STATE_KEY_PREFIX = "github-install-state:";
const INSTALLATION_CLAIM_STATE_KEY_PREFIX = "github-installation-claim-state:";
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const INSTALLATION_ORG_KEY_PREFIX = "github-installation-org:";

type GitHubWebhookRouterInstallationMapping = {
  installationId: string;
  orgId: string;
};

type GitHubWebhookRouterPendingWebhook = {
  key: string;
  installationId: string;
  method: string;
  event: string;
  deliveryId: string;
  receivedAt: number;
};

type GitHubWebhookRouterInstallState = {
  statePreview: string;
  userId: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
};

type GitHubWebhookRouterSnapshot = {
  installationMappings: GitHubWebhookRouterInstallationMapping[];
  pendingWebhooks: GitHubWebhookRouterPendingWebhook[];
  activeInstallStates: GitHubWebhookRouterInstallState[];
  counts: {
    installationMappings: number;
    pendingWebhooks: number;
    activeInstallStates: number;
  };
};

type GitHubWebhookRouterObjectState = Pick<DurableObjectState, "storage">;

const githubWebhookTextEncoder = new TextEncoder();
const githubWebhookTextDecoder = new TextDecoder();

function githubWebhookJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function getWebhookLogContext(request: Request) {
  return {
    deliveryId: request.headers.get("x-github-delivery") ?? "",
    event: request.headers.get("x-github-event") ?? "",
    method: request.method,
  };
}

function timingSafeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) {
    mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return mismatch === 0;
}

async function verifyWebhookSignature({
  payloadBytes,
  signatureHeader,
  secret,
}: {
  payloadBytes: Uint8Array;
  signatureHeader: string | null;
  secret: string;
}): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }

  const [scheme, digest] = signatureHeader.split("=", 2);
  if (scheme !== "sha256" || !digest) {
    return false;
  }

  const normalizedDigest = digest.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) {
    return false;
  }

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    githubWebhookTextEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payloadBuffer =
    payloadBytes.buffer instanceof ArrayBuffer
      ? payloadBytes.buffer.slice(
          payloadBytes.byteOffset,
          payloadBytes.byteOffset + payloadBytes.byteLength,
        )
      : payloadBytes.slice().buffer;
  const expected = await crypto.subtle.sign("HMAC", hmacKey, payloadBuffer);
  return timingSafeEqual(bytesToHex(new Uint8Array(expected)), normalizedDigest);
}

function getInstallationIdFromPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const installation = isRecord(payload.installation) ? payload.installation : null;
  const nestedInstallationId = toStringValue(installation?.id);
  return nestedInstallationId || toStringValue(payload.installation_id);
}

async function extractWebhookPayload(request: Request) {
  const payloadBuffer = await request.clone().arrayBuffer();
  const payloadBytes = new Uint8Array(payloadBuffer);
  const payloadText = githubWebhookTextDecoder.decode(payloadBytes);
  if (!payloadText) {
    return { installationId: "", payloadText: "", payloadBytes, parseError: false };
  }

  try {
    const payload = JSON.parse(payloadText) as unknown;
    return {
      installationId: getInstallationIdFromPayload(payload),
      payloadText,
      payloadBytes,
      parseError: false,
    };
  } catch {
    return { installationId: "", payloadText, payloadBytes, parseError: true };
  }
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const createInstallNonce = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

const toStateTokenPreview = (value: string) => {
  if (!value) {
    return "";
  }
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}…`;
};

export class InMemoryGitHubWebhookRouterObject {
  readonly #env: CloudflareEnv;
  readonly #state: GitHubWebhookRouterObjectState;
  readonly #runtime: BackofficeRuntimeServices;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: GitHubWebhookRouterObjectState;
    env: CloudflareEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtime = runtime;
  }

  async fetch(request: Request): Promise<Response> {
    const webhookMeta = getWebhookLogContext(request);
    try {
      const { installationId, payloadText, payloadBytes, parseError } =
        await extractWebhookPayload(request);
      const webhookSecret = this.#env.GITHUB_APP_WEBHOOK_SECRET?.trim() ?? "";
      if (!webhookSecret) {
        console.error("GitHub webhook secret is not configured", webhookMeta);
        return githubWebhookJsonResponse(
          {
            message: "GitHub webhook secret is not configured.",
            code: "WEBHOOK_SECRET_NOT_CONFIGURED",
          },
          500,
        );
      }

      const signatureValid = await verifyWebhookSignature({
        payloadBytes,
        signatureHeader: request.headers.get("x-hub-signature-256"),
        secret: webhookSecret,
      });
      if (!signatureValid) {
        console.warn("GitHub webhook rejected due to invalid signature", {
          ...webhookMeta,
          parseError,
          payloadSize: payloadText.length,
        });
        return githubWebhookJsonResponse(
          { message: "Invalid webhook signature.", code: "WEBHOOK_SIGNATURE_INVALID" },
          401,
        );
      }

      if (!installationId) {
        console.warn("GitHub webhook missing installation id", {
          ...webhookMeta,
          parseError,
          payloadSize: payloadText.length,
        });
        return githubWebhookJsonResponse(
          {
            message: "Missing installation id in webhook payload.",
            code: "WEBHOOK_INSTALLATION_ID_MISSING",
          },
          400,
        );
      }

      const orgId = await this.getInstallationOrg(installationId);
      if (!orgId) {
        console.warn("GitHub webhook rejected because installation mapping was not found", {
          ...webhookMeta,
          installationId,
          parseError,
          payloadSize: payloadText.length,
        });
        return githubWebhookJsonResponse(
          {
            message:
              "No organization mapping found for installation id. Complete installation from backoffice first.",
            code: "INSTALLATION_ORG_MAPPING_NOT_FOUND",
            installationId,
          },
          404,
        );
      }

      const githubObject = this.#runtime.objects.github.forOrg(orgId);
      await githubObject.commands.ensureAdminConfig(orgId);

      const url = new URL(request.url);
      url.pathname = "/api/github/webhooks";
      url.searchParams.set("orgId", orgId);
      const response = await githubObject.http.fetch(new Request(url.toString(), request));
      if (!response.ok) {
        console.warn("Forwarded GitHub webhook returned non-success status", {
          ...webhookMeta,
          installationId,
          orgId,
          status: response.status,
          statusText: response.statusText,
        });
      }
      return response;
    } catch (error) {
      console.error("GitHub webhook handler failed", { ...webhookMeta, error });
      return githubWebhookJsonResponse(
        { message: "Webhook processing failed.", code: "WEBHOOK_PROCESSING_FAILED" },
        500,
      );
    }
  }

  async getAdminConfig(_orgId: string, origin: string): Promise<AdminConfigResponse> {
    const webhookUrl = resolveWebhookUrl(origin);
    const resolution = resolveGitHubConfig(this.#env);

    if (!resolution.ok) {
      const privateKeySource =
        this.#env.GITHUB_APP_PRIVATE_KEY?.trim() &&
        this.#env.GITHUB_APP_PRIVATE_KEY.trim().length > 0
          ? "env"
          : "file";
      return {
        configured: false,
        missing: resolution.missing,
        error: resolution.error,
        app: {
          appId: this.#env.GITHUB_APP_ID?.trim() || "",
          appSlug: this.#env.GITHUB_APP_SLUG?.trim() || "",
          privateKeySource,
          webhookSecretPreview: this.#env.GITHUB_APP_WEBHOOK_SECRET
            ? maskSecret(this.#env.GITHUB_APP_WEBHOOK_SECRET)
            : "",
          webhookUrl,
          installUrl: this.#env.GITHUB_APP_SLUG?.trim()
            ? `https://github.com/apps/${this.#env.GITHUB_APP_SLUG.trim()}/installations/new`
            : "https://github.com/settings/apps",
          docsUrl: this.#env.GITHUB_APP_SLUG?.trim()
            ? `https://github.com/apps/${this.#env.GITHUB_APP_SLUG.trim()}`
            : "https://github.com/settings/apps",
        },
      };
    }

    return {
      configured: true,
      missing: [],
      error: null,
      app: {
        appId: resolution.config.appId,
        appSlug: resolution.config.appSlug,
        privateKeySource: resolution.config.privateKeySource,
        webhookSecretPreview: maskSecret(resolution.config.webhookSecret),
        webhookUrl,
        installUrl: `https://github.com/apps/${resolution.config.appSlug}/installations/new`,
        docsUrl: `https://github.com/apps/${resolution.config.appSlug}`,
      },
    };
  }

  async createInstallStatefulUrl(userId: string, orgId: string): Promise<CreateInstallUrlResult> {
    const normalizedUserId = userId.trim();
    const normalizedOrgId = orgId.trim();
    if (!normalizedUserId) {
      return {
        ok: false,
        message: "Missing user id.",
      };
    }
    if (!normalizedOrgId) {
      return {
        ok: false,
        message: "Missing organization id.",
      };
    }

    const resolution = resolveGitHubConfig(this.#env);
    if (!resolution.ok) {
      return {
        ok: false,
        message: "GitHub app is not configured.",
        missing: resolution.missing,
        error: resolution.error,
      };
    }

    const state = createInstallNonce();
    const now = Date.now();
    const expiresAt = now + INSTALL_STATE_TTL_MS;
    const storageKey = `${INSTALL_STATE_KEY_PREFIX}${state}`;
    const record: StoredInstallState = {
      userId: normalizedUserId,
      orgId: normalizedOrgId,
      createdAt: now,
      expiresAt,
    };

    await this.#state.storage.put(storageKey, record);

    return {
      ok: true,
      installUrl: `https://github.com/apps/${resolution.config.appSlug}/installations/new?state=${encodeURIComponent(state)}`,
      expiresAt,
    };
  }

  async resolveInstallState(
    input: ResolveInstallStateInput,
  ): Promise<InstallStateResolutionResult> {
    const state = input.state.trim();
    const userId = input.userId.trim();

    if (!state || !userId) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Missing install state or user id.",
      };
    }

    const storageKey = `${INSTALL_STATE_KEY_PREFIX}${state}`;
    const record = await this.#state.storage.get<StoredInstallState>(storageKey);
    if (!record) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Installation state was not found or already used.",
      };
    }

    if (record.expiresAt <= Date.now()) {
      await this.#state.storage.delete(storageKey);
      return {
        ok: false,
        code: "EXPIRED_STATE",
        message: "Installation state expired. Start the install flow again.",
      };
    }

    if (record.userId !== userId) {
      return {
        ok: false,
        code: "USER_MISMATCH",
        message: "Installation state belongs to a different user.",
      };
    }

    if (!record.orgId || record.orgId.trim().length === 0) {
      await this.#state.storage.delete(storageKey);
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Installation state is missing organization context.",
      };
    }

    return {
      ok: true,
      orgId: record.orgId.trim(),
    };
  }

  async consumeInstallState(input: ConsumeInstallStateInput): Promise<ConsumeInstallStateResult> {
    const state = input.state.trim();
    const installationId = input.installationId.trim();

    if (!state || !installationId) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: "Missing install state or installation id.",
      };
    }

    const resolved = await this.resolveInstallState({
      state,
      userId: input.userId,
    });
    if (!resolved.ok) {
      return resolved;
    }

    await this.#state.storage.delete(`${INSTALL_STATE_KEY_PREFIX}${state}`);
    return {
      ok: true,
      installationId,
      orgId: resolved.orgId,
    };
  }

  async storeInstallationClaimState(
    input: StoreInstallationClaimStateInput,
  ): Promise<{ ok: true }> {
    const state = input.state.trim();
    const userId = input.userId.trim();
    const orgId = input.orgId.trim();
    if (!state || !userId || !orgId) {
      throw new Error("Missing installation claim state, user id, or organization id.");
    }

    await this.#state.storage.put(`${INSTALLATION_CLAIM_STATE_KEY_PREFIX}${state}`, {
      userId,
      orgId,
      returnTo: input.returnTo.trim(),
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
    } satisfies StoredInstallationClaimState);
    return { ok: true };
  }

  async resolveInstallationClaimState(
    input: ResolveInstallStateInput,
  ): Promise<InstallationClaimStateResolutionResult> {
    const state = input.state.trim();
    const userId = input.userId.trim();

    if (!state || !userId) {
      return { ok: false, code: "INVALID_STATE", message: "Missing claim state or user id." };
    }

    const storageKey = `${INSTALLATION_CLAIM_STATE_KEY_PREFIX}${state}`;
    const record = await this.#state.storage.get<StoredInstallationClaimState>(storageKey);
    if (!record) {
      return { ok: false, code: "INVALID_STATE", message: "Claim state was not found." };
    }
    if (record.expiresAt <= Date.now()) {
      await this.#state.storage.delete(storageKey);
      return { ok: false, code: "EXPIRED_STATE", message: "Claim state expired." };
    }
    if (record.userId !== userId) {
      return {
        ok: false,
        code: "USER_MISMATCH",
        message: "Claim state belongs to a different user.",
      };
    }

    return {
      ok: true,
      orgId: record.orgId,
      returnTo: record.returnTo,
      completion: record.completion ?? null,
    };
  }

  async storeInstallationClaimCompletion(
    input: StoreInstallationClaimCompletionInput,
  ): Promise<{ ok: true }> {
    const resolved = await this.resolveInstallationClaimState({
      state: input.state,
      userId: input.userId,
    });
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    const storageKey = `${INSTALLATION_CLAIM_STATE_KEY_PREFIX}${input.state.trim()}`;
    const record = await this.#state.storage.get<StoredInstallationClaimState>(storageKey);
    if (!record) {
      throw new Error("Claim state was not found.");
    }

    await this.#state.storage.put(storageKey, {
      ...record,
      completion: input.completion,
    } satisfies StoredInstallationClaimState);
    return { ok: true };
  }

  async consumeInstallationClaimState(input: ResolveInstallStateInput): Promise<{ ok: true }> {
    await this.#state.storage.delete(`${INSTALLATION_CLAIM_STATE_KEY_PREFIX}${input.state.trim()}`);
    return { ok: true };
  }

  async setInstallationOrg(
    installationId: string,
    orgId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        message: string;
        code?: "INSTALLATION_ORG_CONFLICT";
        existingOrgId?: string;
      }
  > {
    const normalizedInstallationId = installationId.trim();
    const normalizedOrgId = orgId.trim();
    if (!normalizedInstallationId) {
      return { ok: false, message: "Missing installation id." };
    }
    if (!normalizedOrgId) {
      return { ok: false, message: "Missing organization id." };
    }

    const mappingKey = `${INSTALLATION_ORG_KEY_PREFIX}${normalizedInstallationId}`;
    const existingOrgId = await this.#state.storage.get<string>(mappingKey);
    const normalizedExistingOrgId = existingOrgId?.trim() ?? "";

    if (normalizedExistingOrgId && normalizedExistingOrgId !== normalizedOrgId) {
      return {
        ok: false,
        code: "INSTALLATION_ORG_CONFLICT",
        existingOrgId: normalizedExistingOrgId,
        message: "Installation is already mapped to a different organization.",
      };
    }

    if (!normalizedExistingOrgId) {
      await this.#state.storage.put(mappingKey, normalizedOrgId);
    }

    return { ok: true };
  }

  async getInstallationOrg(installationId: string): Promise<string | null> {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return null;
    }

    const orgId = await this.#state.storage.get<string>(
      `${INSTALLATION_ORG_KEY_PREFIX}${normalizedInstallationId}`,
    );
    return typeof orgId === "string" && orgId.trim().length > 0 ? orgId : null;
  }

  async clearInstallationRouting(installationId: string): Promise<{
    ok: true;
    removedMapping: boolean;
    clearedPendingWebhooks: number;
  }> {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return {
        ok: true,
        removedMapping: false,
        clearedPendingWebhooks: 0,
      };
    }

    const mappingKey = `${INSTALLATION_ORG_KEY_PREFIX}${normalizedInstallationId}`;
    const existingMapping = await this.#state.storage.get<string>(mappingKey);
    await this.#state.storage.delete(mappingKey);

    return {
      ok: true,
      removedMapping: typeof existingMapping === "string" && existingMapping.trim().length > 0,
      clearedPendingWebhooks: 0,
    };
  }

  async getWebhookRouterSnapshot(): Promise<GitHubWebhookRouterSnapshot> {
    const installationMappingsList = await this.#state.storage.list<string>({
      prefix: INSTALLATION_ORG_KEY_PREFIX,
    });
    const installationMappings: GitHubWebhookRouterInstallationMapping[] = [];
    for (const [key, value] of installationMappingsList.entries()) {
      if (typeof value !== "string") {
        continue;
      }
      const installationId = key.slice(INSTALLATION_ORG_KEY_PREFIX.length).trim();
      const orgId = value.trim();
      if (!installationId || !orgId) {
        continue;
      }
      installationMappings.push({ installationId, orgId });
    }
    installationMappings.sort((a, b) => a.installationId.localeCompare(b.installationId));
    const pendingWebhooks: GitHubWebhookRouterPendingWebhook[] = [];

    const installStatesList = await this.#state.storage.list<StoredInstallState>({
      prefix: INSTALL_STATE_KEY_PREFIX,
    });
    const activeInstallStates: GitHubWebhookRouterInstallState[] = [];
    for (const [key, record] of installStatesList.entries()) {
      const stateToken = key.slice(INSTALL_STATE_KEY_PREFIX.length);
      activeInstallStates.push({
        statePreview: toStateTokenPreview(stateToken),
        userId: record.userId,
        orgId: record.orgId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    }
    activeInstallStates.sort((a, b) => b.createdAt - a.createdAt);

    return {
      installationMappings,
      pendingWebhooks,
      activeInstallStates,
      counts: {
        installationMappings: installationMappings.length,
        pendingWebhooks: 0,
        activeInstallStates: activeInstallStates.length,
      },
    };
  }
}

export class GitHubWebhookRouter extends DurableObject<CloudflareEnv> {
  readonly #object: InMemoryGitHubWebhookRouterObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryGitHubWebhookRouterObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async getAdminConfig(orgId: string, origin: string): Promise<AdminConfigResponse> {
    return await this.#object.getAdminConfig(orgId, origin);
  }

  async createInstallStatefulUrl(userId: string, orgId: string): Promise<CreateInstallUrlResult> {
    return await this.#object.createInstallStatefulUrl(userId, orgId);
  }

  async resolveInstallState(
    input: ResolveInstallStateInput,
  ): Promise<InstallStateResolutionResult> {
    return await this.#object.resolveInstallState(input);
  }

  async consumeInstallState(input: ConsumeInstallStateInput): Promise<ConsumeInstallStateResult> {
    return await this.#object.consumeInstallState(input);
  }

  async storeInstallationClaimState(
    input: StoreInstallationClaimStateInput,
  ): Promise<{ ok: true }> {
    return await this.#object.storeInstallationClaimState(input);
  }

  async resolveInstallationClaimState(
    input: ResolveInstallStateInput,
  ): Promise<InstallationClaimStateResolutionResult> {
    return await this.#object.resolveInstallationClaimState(input);
  }

  async storeInstallationClaimCompletion(
    input: StoreInstallationClaimCompletionInput,
  ): Promise<{ ok: true }> {
    return await this.#object.storeInstallationClaimCompletion(input);
  }

  async consumeInstallationClaimState(input: ResolveInstallStateInput): Promise<{ ok: true }> {
    return await this.#object.consumeInstallationClaimState(input);
  }

  async setInstallationOrg(
    installationId: string,
    orgId: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        message: string;
        code?: "INSTALLATION_ORG_CONFLICT";
        existingOrgId?: string;
      }
  > {
    return await this.#object.setInstallationOrg(installationId, orgId);
  }

  async getInstallationOrg(installationId: string): Promise<string | null> {
    return await this.#object.getInstallationOrg(installationId);
  }

  async clearInstallationRouting(installationId: string): Promise<{
    ok: true;
    removedMapping: boolean;
    clearedPendingWebhooks: number;
  }> {
    return await this.#object.clearInstallationRouting(installationId);
  }

  async getWebhookRouterSnapshot(): Promise<GitHubWebhookRouterSnapshot> {
    return await this.#object.getWebhookRouterSnapshot();
  }
}
