import {
  backofficeContextScopesEqual,
  backofficeJurisdictionSchema,
  backofficeRootOwnerSchema,
  backofficeScopePathSegment,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

import { type BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { GitHubInstallationOwner } from "@/fragno/github";
import { bytesToHex } from "@/lib/crypto";

import { maskSecret, resolveGitHubConfig, resolveWebhookUrl } from "./github.shared";

export type AdminConfigResponse = {
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

type StoredUserState = {
  userId: string;
  owner: GitHubInstallationOwner;
  createdAt: number;
  expiresAt: number;
};

/**
 * Repositories integration setup asked to link once GitHub's callback completes. A GitHub install
 * flow yields one installation on one account, so a request names that account.
 */
type GitHubRepositoryInstallRequest = { owner: string; repositories: string[] };

type StoredInstallState = StoredUserState & {
  /** Null for installs started from the GitHub configuration page. */
  repositoryRequest: GitHubRepositoryInstallRequest | null;
};

type StoredInstallationClaimState = StoredUserState & {
  returnTo: string;
  completion?: unknown;
};

export type CreateInstallUrlResult =
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

export type ConsumeInstallStateInput = {
  state: string;
  userId: string;
  installationId: string;
};

export type ResolveInstallStateInput = {
  state: string;
  userId: string;
};

export type StoreInstallationClaimStateInput = {
  state: string;
  userId: string;
  owner: GitHubInstallationOwner;
  returnTo: string;
  expiresAt: number;
};

export type StoreInstallationClaimCompletionInput = {
  state: string;
  userId: string;
  completion: unknown;
};

export type InstallStateResolutionResult =
  | {
      ok: true;
      owner: GitHubInstallationOwner;
      repositoryRequest: GitHubRepositoryInstallRequest | null;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

export type InstallationClaimStateResolutionResult =
  | {
      ok: true;
      owner: GitHubInstallationOwner;
      returnTo: string;
      completion: unknown;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

export type ConsumeInstallStateResult =
  | {
      ok: true;
      installationId: string;
      owner: GitHubInstallationOwner;
      repositoryRequest: GitHubRepositoryInstallRequest | null;
    }
  | {
      ok: false;
      code: "INVALID_STATE" | "EXPIRED_STATE" | "USER_MISMATCH";
      message: string;
    };

// States name their workspace since personal workspaces could install GitHub. The `v2` prefixes
// leave states that named only an organization unread, so their links fail and are started again.
const INSTALL_STATE_KEY_PREFIX = "github-install-state-v2:";
const INSTALLATION_CLAIM_STATE_KEY_PREFIX = "github-installation-claim-state-v2:";
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
/** Points at a user's newest repository install per workspace and account, so setup resumes it. */
const INSTALL_PENDING_KEY_PREFIX = "github-install-pending-v2:";
const installPendingKey = (owner: GitHubInstallationOwner, userId: string, account: string) =>
  `${INSTALL_PENDING_KEY_PREFIX}${backofficeScopePathSegment(owner)}:${userId}:${account}`;
const installUrl = (appSlug: string, state: string) =>
  `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
// The key predates personal workspaces, when only organizations owned installations.
const INSTALLATION_OWNER_KEY_PREFIX = "github-installation-org:";

/**
 * Mappings name the owner's scope, so webhooks reach its objects without asking Auth where they
 * are kept. Mappings without a kind predate personal workspaces, and mappings stored by ID alone
 * predate jurisdictions, as did their organizations.
 */
const storedInstallationOwnerSchema = z.union([
  backofficeRootOwnerSchema,
  z
    .string()
    .trim()
    .min(1)
    .transform((orgId) => ({ kind: "org" as const, orgId, jurisdiction: null })),
  z
    .object({ orgId: z.string().min(1), jurisdiction: backofficeJurisdictionSchema.nullable() })
    .transform((organization) => ({ kind: "org" as const, ...organization })),
]);

function readInstallationOwner(stored: unknown): GitHubInstallationOwner | null {
  const parsed = storedInstallationOwnerSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

type GitHubWebhookRouterInstallationMapping = {
  installationId: string;
  owner: GitHubInstallationOwner;
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
  owner: GitHubInstallationOwner;
  createdAt: number;
  expiresAt: number;
};

export type GitHubWebhookRouterSnapshot = {
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

export class GitHubWebhookRouterObject {
  readonly #env: Parameters<typeof resolveGitHubConfig>[0];
  readonly #state: GitHubWebhookRouterObjectState;
  readonly #runtime: BackofficeRuntimeServices;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: GitHubWebhookRouterObjectState;
    env: Parameters<typeof resolveGitHubConfig>[0];
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

      const owner = await this.getInstallationOwner(installationId);
      if (!owner) {
        console.warn("GitHub webhook rejected because installation mapping was not found", {
          ...webhookMeta,
          installationId,
          parseError,
          payloadSize: payloadText.length,
        });
        return githubWebhookJsonResponse(
          {
            message:
              "No workspace mapping found for installation id. Complete installation from backoffice first.",
            code: "INSTALLATION_OWNER_MAPPING_NOT_FOUND",
            installationId,
          },
          404,
        );
      }

      const githubObject = this.#runtime.objects.github.for(owner);
      await githubObject.commands.ensureAdminConfig();

      const url = new URL(request.url);
      url.pathname = "/api/github/webhooks";
      const response = await githubObject.http.fetch(new Request(url.toString(), request));
      if (!response.ok) {
        console.warn("Forwarded GitHub webhook returned non-success status", {
          ...webhookMeta,
          installationId,
          owner: backofficeScopePathSegment(owner),
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

  /** Whether the environment carries a complete GitHub App configuration. */
  async isAppConfigured(): Promise<boolean> {
    return resolveGitHubConfig(this.#env).ok;
  }

  async createInstallStatefulUrl(
    userId: string,
    owner: GitHubInstallationOwner,
  ): Promise<CreateInstallUrlResult> {
    return await this.#storeInstallState(userId, owner, null);
  }

  /**
   * Returns an install link whose callback links the repository. The user's pending link for the
   * same workspace and account is reused, so repeated setup calls resume one GitHub consent.
   */
  async requestRepositoryInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    repositoryFullName: string,
  ): Promise<CreateInstallUrlResult> {
    const account = repositoryFullName.slice(0, repositoryFullName.indexOf("/"));
    const pending = await this.#readPendingInstallState(userId.trim(), owner, account);
    if (pending === null) {
      return await this.#storeInstallState(userId, owner, {
        owner: account,
        repositories: [repositoryFullName],
      });
    }
    const { repositories } = pending.request;
    if (!repositories.includes(repositoryFullName)) {
      await this.#state.storage.put(`${INSTALL_STATE_KEY_PREFIX}${pending.state}`, {
        ...pending.record,
        repositoryRequest: { owner: account, repositories: [...repositories, repositoryFullName] },
      } satisfies StoredInstallState);
    }
    return { ok: true, installUrl: pending.installUrl, expiresAt: pending.record.expiresAt };
  }

  /** The user's unused install link for one account and the repositories it will link. */
  async getPendingInstall(
    userId: string,
    owner: GitHubInstallationOwner,
    account: string,
  ): Promise<{ installUrl: string; repositories: string[] } | null> {
    const pending = await this.#readPendingInstallState(userId, owner, account);
    return (
      pending && { installUrl: pending.installUrl, repositories: pending.request.repositories }
    );
  }

  async #readPendingInstallState(userId: string, owner: GitHubInstallationOwner, account: string) {
    const state = await this.#state.storage.get<string>(installPendingKey(owner, userId, account));
    if (!state) {
      return null;
    }
    const record = await this.#state.storage.get<StoredInstallState>(
      `${INSTALL_STATE_KEY_PREFIX}${state}`,
    );
    const resolution = resolveGitHubConfig(this.#env);
    if (!record?.repositoryRequest || record.expiresAt <= Date.now() || !resolution.ok) {
      return null;
    }
    return {
      state,
      record,
      request: record.repositoryRequest,
      installUrl: installUrl(resolution.config.appSlug, state),
    };
  }

  async #storeInstallState(
    userId: string,
    owner: GitHubInstallationOwner,
    repositoryRequest: GitHubRepositoryInstallRequest | null,
  ): Promise<CreateInstallUrlResult> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return {
        ok: false,
        message: "Missing user id.",
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
    const record: StoredInstallState = {
      userId: normalizedUserId,
      owner,
      createdAt: now,
      expiresAt,
      repositoryRequest,
    };

    await this.#state.storage.put(`${INSTALL_STATE_KEY_PREFIX}${state}`, record);
    if (repositoryRequest !== null) {
      await this.#state.storage.put(
        installPendingKey(owner, normalizedUserId, repositoryRequest.owner),
        state,
      );
    }

    return {
      ok: true,
      installUrl: installUrl(resolution.config.appSlug, state),
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

    return {
      ok: true,
      owner: record.owner,
      repositoryRequest: record.repositoryRequest,
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
    if (resolved.repositoryRequest !== null) {
      const pendingKey = installPendingKey(
        resolved.owner,
        input.userId.trim(),
        resolved.repositoryRequest.owner,
      );
      if ((await this.#state.storage.get<string>(pendingKey)) === state) {
        await this.#state.storage.delete(pendingKey);
      }
    }
    return {
      ok: true,
      installationId,
      owner: resolved.owner,
      repositoryRequest: resolved.repositoryRequest,
    };
  }

  async storeInstallationClaimState(
    input: StoreInstallationClaimStateInput,
  ): Promise<{ ok: true }> {
    const state = input.state.trim();
    const userId = input.userId.trim();
    if (!state || !userId) {
      throw new Error("Missing installation claim state or user id.");
    }

    await this.#state.storage.put(`${INSTALLATION_CLAIM_STATE_KEY_PREFIX}${state}`, {
      userId,
      owner: input.owner,
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
      owner: record.owner,
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

  async setInstallationOwner(
    installationId: string,
    owner: GitHubInstallationOwner,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        code: "MISSING_INSTALLATION_ID" | "INSTALLATION_OWNER_CONFLICT";
        message: string;
      }
  > {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return { ok: false, code: "MISSING_INSTALLATION_ID", message: "Missing installation id." };
    }

    const mappingKey = `${INSTALLATION_OWNER_KEY_PREFIX}${normalizedInstallationId}`;
    const existing = readInstallationOwner(await this.#state.storage.get(mappingKey));

    if (existing && !backofficeContextScopesEqual(existing, owner)) {
      return {
        ok: false,
        code: "INSTALLATION_OWNER_CONFLICT",
        message: `Installation is already mapped to ${backofficeScopePathSegment(existing)}.`,
      };
    }

    if (!existing) {
      await this.#state.storage.put(mappingKey, owner);
    }

    return { ok: true };
  }

  async getInstallationOwner(installationId: string): Promise<GitHubInstallationOwner | null> {
    const normalizedInstallationId = installationId.trim();
    if (!normalizedInstallationId) {
      return null;
    }

    return readInstallationOwner(
      await this.#state.storage.get(`${INSTALLATION_OWNER_KEY_PREFIX}${normalizedInstallationId}`),
    );
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

    const mappingKey = `${INSTALLATION_OWNER_KEY_PREFIX}${normalizedInstallationId}`;
    const existingMapping = readInstallationOwner(await this.#state.storage.get(mappingKey));
    await this.#state.storage.delete(mappingKey);

    return {
      ok: true,
      removedMapping: existingMapping !== null,
      clearedPendingWebhooks: 0,
    };
  }

  async getWebhookRouterSnapshot(): Promise<GitHubWebhookRouterSnapshot> {
    const installationMappingsList = await this.#state.storage.list({
      prefix: INSTALLATION_OWNER_KEY_PREFIX,
    });
    const installationMappings: GitHubWebhookRouterInstallationMapping[] = [];
    for (const [key, value] of installationMappingsList.entries()) {
      const installationId = key.slice(INSTALLATION_OWNER_KEY_PREFIX.length).trim();
      const owner = readInstallationOwner(value);
      if (!installationId || !owner) {
        continue;
      }
      installationMappings.push({ installationId, owner });
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
        owner: record.owner,
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
