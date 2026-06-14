import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type {
  CloudflareDispatchNamespaceBinding,
  CloudflareFragmentConfig,
} from "@fragno-dev/cloudflare-fragment";

import type { CloudflareWorkersObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { createCloudflareServer, type CloudflareFragment } from "@/fragno/cloudflare";
import {
  createDurableHookRepositoryRpcTarget,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
} from "./lib/backoffice-fragment-durable-object";

type CloudflareWorkersObjectEnv = {
  CLOUDFLARE_WORKERS_ACCOUNT_ID?: string;
  CLOUDFLARE_WORKERS_API_TOKEN?: string;
  DISPATCHER?: CloudflareDispatchNamespaceBinding;
};

type StoredCloudflareWorkersConfig = {
  orgId: string;
};

const CONFIG_KEY = "cloudflare-workers-config";
// Keep this in sync with `dispatch_namespaces[].namespace` in wrangler.jsonc.
const CLOUDFLARE_WFP_NAMESPACE = "staging";
// Keep this in sync with `compatibility_date` in wrangler.jsonc.
const COMPATIBILITY_DATE = "2025-09-01";

type CloudflareWorkersConfigResolution =
  | {
      ok: true;
      config: CloudflareFragmentConfig;
    }
  | {
      ok: false;
      missing: string[];
      error: string | null;
    };

type CloudflareWorkersHookQueueInput = DurableHookQueueOptions & {
  orgId: string;
};

const storedCloudflareWorkersConfigSchema: z.ZodType<StoredCloudflareWorkersConfig> = z.object({
  orgId: z
    .string()
    .trim()
    .min(1, "Stored Cloudflare Workers config is missing an organisation id."),
});

const hookQueueInputSchema = z.object({
  orgId: z.string().trim().min(1, "Missing organisation id."),
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
});

const resolveCloudflareWorkersConfig = (
  env: CloudflareWorkersObjectEnv,
  orgId: string,
): CloudflareWorkersConfigResolution => {
  const accountId = env.CLOUDFLARE_WORKERS_ACCOUNT_ID?.trim() ?? "";
  const apiToken = env.CLOUDFLARE_WORKERS_API_TOKEN?.trim() ?? "";

  const missing: string[] = [];
  if (!accountId) {
    missing.push("CLOUDFLARE_WORKERS_ACCOUNT_ID");
  }
  if (!apiToken) {
    missing.push("CLOUDFLARE_WORKERS_API_TOKEN");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      error: null,
    };
  }

  return {
    ok: true,
    config: {
      accountId,
      apiToken,
      dispatcher: {
        binding: env.DISPATCHER as CloudflareDispatchNamespaceBinding,
        namespace: CLOUDFLARE_WFP_NAMESPACE,
      },
      compatibilityDate: COMPATIBILITY_DATE,
      deploymentTagPrefix: `fragno-${orgId}`,
      scriptNamePrefix: `fragno-${orgId}`,
      scriptNameSuffix: "worker",
    },
  };
};

const resolveRequestOrgId = (request: Request) =>
  new URL(request.url).searchParams.get("orgId")?.trim() || null;

const notConfiguredResponse = (
  resolution: Exclude<CloudflareWorkersConfigResolution, { ok: true }> | null,
) =>
  Response.json(
    {
      message: resolution?.error ?? "Cloudflare Workers is not configured for this environment.",
      code: "NOT_CONFIGURED",
      missing: resolution?.missing ?? [],
    },
    { status: 400 },
  );

const orgMismatchResponse = (expectedOrgId: string, orgId: string) =>
  Response.json(
    {
      message: `Cloudflare Workers Durable Object is bound to organisation "${expectedOrgId}" and cannot serve requests for organisation "${orgId}".`,
      code: "ORG_ID_MISMATCH",
      expectedOrgId,
      orgId,
    },
    { status: 409 },
  );

export class InMemoryCloudflareWorkersObject implements CloudflareWorkersObject {
  #env: CloudflareWorkersObjectEnv;
  #state: BackofficeObjectState;
  #runtimeServices: BackofficeRuntimeServices;
  #host: BackofficeFragmentDurableObject<
    StoredCloudflareWorkersConfig,
    CloudflareFragmentConfig,
    CloudflareFragment
  >;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: CloudflareWorkersObjectEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Cloudflare Workers",
      state,
      env,
      configKey: CONFIG_KEY,
      parseStored: (raw) => storedCloudflareWorkersConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredCloudflareWorkersConfig => {
        if (!stored) {
          return false;
        }
        return resolveCloudflareWorkersConfig(this.#env, stored.orgId).ok;
      },
      toSource: (stored) => {
        const resolution = resolveCloudflareWorkersConfig(this.#env, stored.orgId);
        if (!resolution.ok) {
          throw new Error(
            resolution.error ??
              `Cloudflare Workers configuration is missing: ${resolution.missing.join(", ")}`,
          );
        }
        return resolution.config;
      },
      createRuntime: (config) =>
        createCloudflareServer(config, {
          adapters: this.#runtimeServices.adapters,
        }),
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  async #configureOrgIfNeeded(orgId: string) {
    const stored = await this.#host.loadStored();
    this.#host.assertSameOrg(stored, orgId);

    if (stored) {
      await this.#host.initializeFromStored(stored);
      return;
    }

    await this.#host.storeAndInitialize({ orgId });
  }

  async alarm() {
    await this.#host.alarm();
  }

  getDurableHookRepository() {
    const repository = this.#host.getDurableHookRepository<CloudflareWorkersHookQueueInput>(
      ({ runtime }) => runtime,
    );

    const parseAndConfigure = async (input: CloudflareWorkersHookQueueInput) => {
      const parsed = hookQueueInputSchema.parse(input);
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#configureOrgIfNeeded(parsed.orgId);
      });
      return parsed;
    };

    return createDurableHookRepositoryRpcTarget({
      getHookQueue: async (input: CloudflareWorkersHookQueueInput) =>
        await repository.getHookQueue(await parseAndConfigure(input)),
      getHook: async (hookId: string, input: CloudflareWorkersHookQueueInput) =>
        await repository.getHook(hookId, await parseAndConfigure(input)),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const orgId = resolveRequestOrgId(request);
    const stored = await this.#host.loadStored();
    const storedOrgId = this.#host.getStoredOrgId(stored);

    if (!storedOrgId && !orgId) {
      return notConfiguredResponse({
        ok: false,
        missing: [],
        error: "Missing organisation id for Cloudflare Workers runtime.",
      });
    }

    if (storedOrgId && orgId && storedOrgId !== orgId) {
      return orgMismatchResponse(storedOrgId, orgId);
    }

    if (orgId) {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#configureOrgIfNeeded(orgId);
      });
    } else if (stored) {
      await this.#host.initializeFromStored(stored);
    }

    const configured = this.#host.getConfigured();
    if (!configured) {
      const effectiveOrgId = storedOrgId ?? orgId;
      const resolution = effectiveOrgId
        ? resolveCloudflareWorkersConfig(this.#env, effectiveOrgId)
        : null;
      return notConfiguredResponse(resolution?.ok ? null : (resolution ?? null));
    }

    return await this.#host.fetch(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}

export class CloudflareWorkers
  extends DurableObject<CloudflareEnv>
  implements CloudflareWorkersObject
{
  #object: InMemoryCloudflareWorkersObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryCloudflareWorkersObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  getDurableHookRepository() {
    return this.#object.getDurableHookRepository();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
