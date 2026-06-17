import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { UploadObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { uploadConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/upload";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";
import {
  UPLOAD_ADMIN_CONFIG_KEY,
  UPLOAD_PROVIDER_DATABASE,
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
  createBackofficeFragmentDurableObject,
  type BackofficeDurableHookDependencies,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ProviderResolution = {
  provider: UploadProvider | null;
  invalidProvider: string | null;
};

const uploadProviderSchema = z.enum([
  UPLOAD_PROVIDER_DATABASE,
  UPLOAD_PROVIDER_R2,
  UPLOAD_PROVIDER_R2_BINDING,
]);

const setAdminConfigArgsSchema = z.object({
  orgId: z.string().trim().min(1, "Missing organisation id."),
});

const hookQueueOptionsSchema = z
  .object({
    cursor: z
      .string()
      .trim()
      .transform((value) => value || undefined)
      .optional(),
    pageSize: z
      .number()
      .refine((value) => Number.isFinite(value) && Number.isInteger(value), {
        message: "pageSize must be an integer.",
      })
      .optional(),
  })
  .optional();

const parseUploadProviderInput = (value: string): ProviderResolution => {
  const parsed = z.string().trim().pipe(uploadProviderSchema).safeParse(value);
  if (!parsed.success) {
    return { provider: null, invalidProvider: value.trim() || value };
  }
  return { provider: parsed.data, invalidProvider: null };
};

const configuredProvidersFromResponse = (response: UploadAdminConfigResponse): UploadProvider[] => {
  const providers: UploadProvider[] = [];
  if (response.providers[UPLOAD_PROVIDER_DATABASE]?.configured) {
    providers.push(UPLOAD_PROVIDER_DATABASE);
  }
  if (response.providers[UPLOAD_PROVIDER_R2_BINDING]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2_BINDING);
  }
  if (response.providers[UPLOAD_PROVIDER_R2]?.configured) {
    providers.push(UPLOAD_PROVIDER_R2);
  }
  return providers;
};

const resolveHooksProvider = (response: UploadAdminConfigResponse): UploadProvider | null =>
  response.defaultProvider ?? configuredProvidersFromResponse(response)[0] ?? null;

const uploadNotConfiguredResponse = () =>
  Response.json(
    { message: "Upload is not configured for this organisation.", code: "NOT_CONFIGURED" },
    { status: 400 },
  );

const invalidProviderResponse = (provider: string) =>
  Response.json(
    {
      message: `Upload provider '${provider}' is not supported.`,
      code: "INVALID_PROVIDER",
    },
    { status: 400 },
  );

const providerNotConfiguredResponse = (provider: UploadProvider) =>
  Response.json(
    {
      message: `Upload provider '${provider}' is not configured for this organisation.`,
      code: "PROVIDER_NOT_CONFIGURED",
    },
    { status: 400 },
  );

type UploadRuntime = {
  config: StoredUploadAdminConfig;
  response: UploadAdminConfigResponse;
  fragmentsByProvider: Map<UploadProvider, UploadFragment>;
};

export class InMemoryUploadObject implements UploadObject {
  #state: BackofficeObjectState;
  #env: Parameters<typeof createUploadServerForProvider>[3];
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<
    StoredUploadAdminConfig,
    StoredUploadAdminConfig,
    UploadRuntime
  >;

  constructor({
    state,
    env,
    runtime,
    durableHooks,
  }: {
    state: BackofficeObjectState;
    env: Parameters<typeof createUploadServerForProvider>[3];
    runtime: BackofficeRuntimeServices;
    durableHooks?: BackofficeDurableHookDependencies;
  }) {
    this.#state = state;
    this.#env = env;
    this.#runtimeServices = runtime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Upload",
      state,
      env,
      configKey: UPLOAD_ADMIN_CONFIG_KEY,
      parseStored: (raw) =>
        normalizeStoredUploadAdminConfig(raw) ?? (raw as StoredUploadAdminConfig),
      isConfigured: (stored): stored is StoredUploadAdminConfig => {
        if (!stored) {
          return false;
        }
        return configuredProvidersFromResponse(buildUploadAdminConfigResponse(stored)).length > 0;
      },
      getStoredOrgId: (stored) => stored.namespace.orgId,
      durableHooks,
      createRuntime: (stored) => this.#createRuntime(stored),
      getMigrationFragments: (runtime) => [...runtime.fragmentsByProvider.values()],
      getHookFragments: (runtime) => [...runtime.fragmentsByProvider.values()],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        fragmentsByProvider: new Map(
          [...runtime.fragmentsByProvider].map(([provider, fragment]) => [
            provider,
            hostFragment(fragment),
          ]),
        ),
      }),
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          await this.#runtimeServices.objects.automations
            .forOrg(stored.namespace.orgId)
            .ingestEvent({
              id: item.id,
              orgId: stored.namespace.orgId,
              source: "upload",
              eventType: "capability.configured",
              occurredAt: item.createdAt,
              payload: {
                capabilityId: "upload",
                capabilityLabel: "Upload",
              },
              actor: AUTOMATION_SYSTEM_ACTOR,
              actors: [AUTOMATION_SYSTEM_ACTOR],
              subject: {
                orgId: stored.namespace.orgId,
                capabilityId: "upload",
              },
            });
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#loadConfig());
    });
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

  #createRuntime(stored: StoredUploadAdminConfig): UploadRuntime {
    const response = buildUploadAdminConfigResponse(stored);
    const fragmentsByProvider = new Map<UploadProvider, UploadFragment>();

    for (const provider of configuredProvidersFromResponse(response)) {
      fragmentsByProvider.set(
        provider,
        createUploadServerForProvider(
          stored,
          provider,
          {
            adapters: this.#runtimeServices.adapters,
          },
          this.#env,
        ),
      );
    }

    return {
      config: stored,
      response,
      fragmentsByProvider,
    };
  }

  async #resolveProviderFromRequest(
    request: Request,
    defaultProvider: UploadProvider | null,
  ): Promise<ProviderResolution> {
    const url = new URL(request.url);
    const queryProvider = url.searchParams.get("provider")?.trim();
    if (queryProvider) {
      return parseUploadProviderInput(queryProvider);
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
            return parseUploadProviderInput(payload.provider);
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
            return parseUploadProviderInput(providerValue);
          }
        } catch {
          // Ignore form parsing errors and continue with fallback/default provider behavior.
        }
      }
    }

    return { provider: defaultProvider, invalidProvider: null };
  }

  async #refreshConfigured() {
    await this.#host.initializeFromStored(await this.#loadConfig());
    return this.#host.getConfigured();
  }

  async #resolveRequestFragment(request: Request, runtime: UploadRuntime) {
    const providerResolution = await this.#resolveProviderFromRequest(
      request,
      runtime.response.defaultProvider,
    );

    if (providerResolution.invalidProvider) {
      return invalidProviderResponse(providerResolution.invalidProvider);
    }

    if (!providerResolution.provider) {
      return uploadNotConfiguredResponse();
    }

    return (
      runtime.fragmentsByProvider.get(providerResolution.provider) ??
      providerNotConfiguredResponse(providerResolution.provider)
    );
  }

  async getAdminConfig(): Promise<UploadAdminConfigResponse> {
    const config = await this.#loadConfig();
    return buildUploadAdminConfigResponse(config);
  }

  async resetAdminConfig(): Promise<UploadAdminConfigResponse> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return buildUploadAdminConfigResponse(null);
  }

  async setAdminConfig(
    payload: unknown,
    orgId: string,
    _origin?: string,
  ): Promise<UploadAdminConfigResponse> {
    const args = setAdminConfigArgsSchema.parse({ orgId });
    const parsedPayload = uploadConfigureInputSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new Error("Only providers 'database', 'r2', and 'r2-binding' are supported.");
    }
    const existing = await this.#loadConfig();
    const resolved = resolveUploadAdminConfigInput({
      payload: parsedPayload.data,
      orgId: args.orgId,
      existing,
    });

    if (!resolved.ok) {
      throw new Error(resolved.message);
    }

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#host.storeAndInitialize(resolved.config);
        const configuredAt = new Date().toISOString();
        await this.#host.dispatch({
          id: `upload:capability.configured:${args.orgId}:${configuredAt}`,
          type: "capability.configured",
          createdAt: configuredAt,
        });
      });
    } catch (error) {
      console.log("Upload migration failed", { error });
      throw new Error("Failed to migrate Upload schema.");
    }

    return buildUploadAdminConfigResponse(resolved.config);
  }

  async getDurableHookRepository() {
    await this.#refreshConfigured();
    return this.#host.getDurableHookRepository<DurableHookQueueOptions>(({ runtime }) => {
      const provider = resolveHooksProvider(runtime.response);
      if (!provider) {
        throw new Error("Upload does not have a configured durable hook provider.");
      }
      return runtime.fragmentsByProvider.get(provider)!;
    }, hookQueueOptionsSchema.parse);
  }

  async alarm(): Promise<void> {
    await this.#refreshConfigured();
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    const configured = await this.#refreshConfigured();
    if (!configured) {
      return uploadNotConfiguredResponse();
    }

    const fragment = await this.#resolveRequestFragment(request, configured.runtime);
    if (fragment instanceof Response) {
      return fragment;
    }

    return await fragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class Upload extends DurableObject<CloudflareEnv> implements UploadObject {
  #object: InMemoryUploadObject;

  constructor(
    state: DurableObjectState,
    env: CloudflareEnv,
    durableHooks?: BackofficeDurableHookDependencies,
  ) {
    super(state, env);
    this.#object = new InMemoryUploadObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
      durableHooks,
    });
  }

  async getAdminConfig(): Promise<UploadAdminConfigResponse> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<UploadAdminConfigResponse> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(
    payload: unknown,
    orgId: string,
    origin?: string,
  ): Promise<UploadAdminConfigResponse> {
    return await this.#object.setAdminConfig(payload, orgId, origin);
  }

  async getDurableHookRepository() {
    return await this.#object.getDurableHookRepository();
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
