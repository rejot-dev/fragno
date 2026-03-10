import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import {
  UPLOAD_ADMIN_CONFIG_KEY,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
  buildUploadAdminConfigResponse,
  normalizeStoredUploadAdminConfig,
  resolveUploadAdminConfigInput,
  type StoredUploadAdminConfig,
  type UploadAdminConfigResponse,
  type UploadProvider,
} from "@/fragno/upload";
import { createUploadServerForProvider, type UploadFragment } from "@/fragno/upload-server";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUploadProvider = (value: string): value is UploadProvider =>
  value === UPLOAD_PROVIDER_R2 || value === UPLOAD_PROVIDER_R2_BINDING;

const configuredProvidersFromResponse = (response: UploadAdminConfigResponse): UploadProvider[] => {
  const providers: UploadProvider[] = [];
  if (response.providers[UPLOAD_PROVIDER_R2_BINDING]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2_BINDING);
  }
  if (response.providers[UPLOAD_PROVIDER_R2]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2);
  }
  return providers;
};

type ProviderResolution = {
  provider: UploadProvider | null;
  invalidProvider: string | null;
};

export class Upload extends DurableObject<CloudflareEnv> {
  #state: DurableObjectState;
  #env: CloudflareEnv;
  #fragmentsByProvider = new Map<UploadProvider, UploadFragment>();
  #fragmentConfigHash: string | null = null;
  #migrated = false;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
    this.#env = env;
  }

  async #loadConfig() {
    const raw = await this.#state.storage.get<StoredUploadAdminConfig | unknown>(
      UPLOAD_ADMIN_CONFIG_KEY,
    );
    if (!raw) {
      return null;
    }

    const normalized = normalizeStoredUploadAdminConfig(raw);
    if (!normalized) {
      return null;
    }

    const needsMigration =
      isRecord(raw) && (!hasOwn(raw, "providers") || !hasOwn(raw, "defaultProvider"));
    if (needsMigration) {
      await this.#state.storage.put(UPLOAD_ADMIN_CONFIG_KEY, normalized);
    }

    return normalized;
  }

  async #resolveProviderFromRequest(
    request: Request,
    defaultProvider: UploadProvider | null,
  ): Promise<ProviderResolution> {
    const url = new URL(request.url);
    const queryProvider = url.searchParams.get("provider")?.trim();
    if (queryProvider) {
      if (!isUploadProvider(queryProvider)) {
        return { provider: null, invalidProvider: queryProvider };
      }
      return { provider: queryProvider, invalidProvider: null };
    }

    const method = request.method.toUpperCase();
    const readsBody =
      method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE";

    if (readsBody) {
      const contentType = request.headers.get("content-type") ?? "";

      if (contentType.includes("application/json")) {
        try {
          const payload = await request.clone().json();
          if (
            isRecord(payload) &&
            typeof payload.provider === "string" &&
            payload.provider.trim()
          ) {
            const bodyProvider = payload.provider.trim();
            if (!isUploadProvider(bodyProvider)) {
              return { provider: null, invalidProvider: bodyProvider };
            }
            return { provider: bodyProvider, invalidProvider: null };
          }
        } catch {
          // Ignore invalid JSON and continue with fallback/default provider behavior.
        }
      } else if (
        contentType.includes("multipart/form-data") ||
        contentType.includes("application/x-www-form-urlencoded")
      ) {
        try {
          const formData = await request.clone().formData();
          const providerValue = formData.get("provider");
          if (typeof providerValue === "string" && providerValue.trim()) {
            const bodyProvider = providerValue.trim();
            if (!isUploadProvider(bodyProvider)) {
              return { provider: null, invalidProvider: bodyProvider };
            }
            return { provider: bodyProvider, invalidProvider: null };
          }
        } catch {
          // Ignore form parsing errors and continue with fallback/default provider behavior.
        }
      }
    }

    return { provider: defaultProvider, invalidProvider: null };
  }

  async #ensureFragments() {
    const stored = await this.#loadConfig();
    const response = buildUploadAdminConfigResponse(stored);
    const configuredProviders = configuredProvidersFromResponse(response);

    if (!stored || configuredProviders.length === 0) {
      this.#fragmentsByProvider.clear();
      this.#fragmentConfigHash = null;
      this.#migrated = false;
      return null;
    }

    const nextConfigHash = JSON.stringify(stored);
    if (
      !this.#fragmentConfigHash ||
      this.#fragmentConfigHash !== nextConfigHash ||
      this.#fragmentsByProvider.size !== configuredProviders.length
    ) {
      const nextFragments = new Map<UploadProvider, UploadFragment>();
      for (const provider of configuredProviders) {
        nextFragments.set(
          provider,
          createUploadServerForProvider(stored, provider, this.#state, this.#env),
        );
      }
      this.#fragmentsByProvider = nextFragments;
      this.#fragmentConfigHash = nextConfigHash;
      this.#migrated = false;
    }

    if (!this.#migrated && this.#fragmentsByProvider.size > 0) {
      const migrationTarget =
        (response.defaultProvider && this.#fragmentsByProvider.get(response.defaultProvider)) ||
        this.#fragmentsByProvider.values().next().value;
      if (migrationTarget) {
        await migrate(migrationTarget);
      }
      this.#migrated = true;
    }

    return {
      config: stored,
      response,
    };
  }

  async getAdminConfig(): Promise<UploadAdminConfigResponse> {
    const config = await this.#loadConfig();
    return buildUploadAdminConfigResponse(config);
  }

  async setAdminConfig(
    payload: unknown,
    orgId: string,
    _origin?: string,
  ): Promise<UploadAdminConfigResponse> {
    const existing = await this.#loadConfig();
    const resolved = resolveUploadAdminConfigInput({
      payload,
      orgId,
      existing,
    });

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    await this.#state.storage.put(UPLOAD_ADMIN_CONFIG_KEY, resolved.config);

    this.#fragmentsByProvider.clear();
    this.#fragmentConfigHash = null;
    this.#migrated = false;

    try {
      await this.#ensureFragments();
    } catch (error) {
      console.log("Upload migration failed", { error });
      throw new Error("Failed to migrate Upload schema.");
    }

    return buildUploadAdminConfigResponse(resolved.config);
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    const ensured = await this.#ensureFragments();
    if (!ensured) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    const provider =
      ensured.response.defaultProvider ??
      configuredProvidersFromResponse(ensured.response)[0] ??
      null;
    if (!provider) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    const fragment = this.#fragmentsByProvider.get(provider);
    if (!fragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(fragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    const ensured = await this.#ensureFragments();
    if (!ensured) {
      return jsonResponse(
        { message: "Upload is not configured for this organisation.", code: "NOT_CONFIGURED" },
        400,
      );
    }

    const providerResolution = await this.#resolveProviderFromRequest(
      request,
      ensured.response.defaultProvider,
    );
    if (providerResolution.invalidProvider) {
      return jsonResponse(
        {
          message: `Upload provider '${providerResolution.invalidProvider}' is not supported.`,
          code: "INVALID_PROVIDER",
        },
        400,
      );
    }

    if (!providerResolution.provider) {
      return jsonResponse(
        { message: "Upload is not configured for this organisation.", code: "NOT_CONFIGURED" },
        400,
      );
    }

    const fragment = this.#fragmentsByProvider.get(providerResolution.provider);
    if (!fragment) {
      return jsonResponse(
        {
          message: `Upload provider '${providerResolution.provider}' is not configured for this organisation.`,
          code: "PROVIDER_NOT_CONFIGURED",
        },
        400,
      );
    }

    return fragment.handler(request);
  }
}
