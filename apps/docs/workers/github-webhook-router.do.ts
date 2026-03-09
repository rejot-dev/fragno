import { DurableObject } from "cloudflare:workers";
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

export class GitHubWebhookRouter extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
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
        message: "Missing organisation id.",
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
        message: "Installation state is missing organisation context.",
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
      return { ok: false, message: "Missing organisation id." };
    }

    const mappingKey = `${INSTALLATION_ORG_KEY_PREFIX}${normalizedInstallationId}`;
    const existingOrgId = await this.#state.storage.get<string>(mappingKey);
    const normalizedExistingOrgId = existingOrgId?.trim() ?? "";

    if (normalizedExistingOrgId && normalizedExistingOrgId !== normalizedOrgId) {
      return {
        ok: false,
        code: "INSTALLATION_ORG_CONFLICT",
        existingOrgId: normalizedExistingOrgId,
        message: "Installation is already mapped to a different organisation.",
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
