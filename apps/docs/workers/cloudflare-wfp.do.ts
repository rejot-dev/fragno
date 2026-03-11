import { DurableObject } from "cloudflare:workers";
import {
  resolveCloudflareDispatchNamespaceName,
  type CloudflareFragmentConfig,
} from "@fragno-dev/cloudflare-fragment";
import { migrate } from "@fragno-dev/db";
import {
  createDurableHooksProcessor,
  type DurableHooksDispatcherDurableObjectHandler,
} from "@fragno-dev/db/dispatchers/cloudflare-do";
import { createCloudflareServer, type CloudflareFragment } from "@/fragno/cloudflare";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

const ORG_ID_STORAGE_KEY = "cloudflare-workers-org-id";
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

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const sameStringList = (left?: string[], right?: string[]) => {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];

  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }

  return normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
};

const resolveDispatcherConfig = (config: CloudflareFragmentConfig) => {
  if ("dispatcher" in config && config.dispatcher !== undefined) {
    return config.dispatcher;
  }

  if ("dispatchNamespace" in config && config.dispatchNamespace !== undefined) {
    return config.dispatchNamespace;
  }

  return null;
};

const resolveDispatcherNamespaceName = (config: CloudflareFragmentConfig) => {
  const dispatcher = resolveDispatcherConfig(config);
  return dispatcher ? resolveCloudflareDispatchNamespaceName(dispatcher) : null;
};

const readApiToken = (config: CloudflareFragmentConfig) => {
  return "apiToken" in config ? config.apiToken : null;
};

const configsEqual = (left: CloudflareFragmentConfig, right: CloudflareFragmentConfig) => {
  const leftDispatcherNamespace = resolveDispatcherNamespaceName(left);
  const rightDispatcherNamespace = resolveDispatcherNamespaceName(right);

  return (
    left.accountId === right.accountId &&
    readApiToken(left) === readApiToken(right) &&
    leftDispatcherNamespace !== null &&
    rightDispatcherNamespace !== null &&
    leftDispatcherNamespace === rightDispatcherNamespace &&
    left.compatibilityDate === right.compatibilityDate &&
    sameStringList(left.compatibilityFlags, right.compatibilityFlags) &&
    sameStringList(left.scriptTags, right.scriptTags) &&
    left.deploymentTagPrefix === right.deploymentTagPrefix &&
    left.scriptNamePrefix === right.scriptNamePrefix &&
    left.scriptNameSuffix === right.scriptNameSuffix &&
    left.scriptNameSeparator === right.scriptNameSeparator &&
    left.maxScriptNameLength === right.maxScriptNameLength
  );
};

const resolveCloudflareWorkersConfig = (
  env: CloudflareEnv,
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
        binding: env.DISPATCHER,
        namespace: CLOUDFLARE_WFP_NAMESPACE,
      },
      compatibilityDate: COMPATIBILITY_DATE,
      deploymentTagPrefix: `fragno-${orgId}`,
      scriptNamePrefix: `fragno-${orgId}`,
      scriptNameSuffix: "worker",
    },
  };
};

export class CloudflareWorkers extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #fragment: CloudflareFragment | null = null;
  #fragmentConfig: CloudflareFragmentConfig | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  #migrated = false;
  #orgId: string | null = null;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
  }

  async #loadOrgId() {
    if (this.#orgId) {
      return this.#orgId;
    }

    const storedOrgId = await this.#state.storage.get<string>(ORG_ID_STORAGE_KEY);
    if (typeof storedOrgId === "string" && storedOrgId.trim()) {
      this.#orgId = storedOrgId.trim();
      return this.#orgId;
    }

    return null;
  }

  async #rememberOrgId(orgId: string) {
    const normalizedOrgId = orgId.trim();
    if (!normalizedOrgId) {
      return null;
    }

    const existingOrgId = this.#orgId ?? (await this.#loadOrgId());
    if (existingOrgId && existingOrgId !== normalizedOrgId) {
      throw new Error(
        `Cloudflare Workers Durable Object is already bound to organisation "${existingOrgId}".`,
      );
    }

    if (!existingOrgId) {
      this.#orgId = normalizedOrgId;
      await this.#state.storage.put(ORG_ID_STORAGE_KEY, normalizedOrgId);
    }

    return normalizedOrgId;
  }

  async #resolveOrgId(request?: Request, orgIdHint?: string) {
    if (orgIdHint?.trim()) {
      return await this.#rememberOrgId(orgIdHint);
    }

    if (!request) {
      return await this.#loadOrgId();
    }

    const orgIdFromQuery = new URL(request.url).searchParams.get("orgId");
    if (orgIdFromQuery?.trim()) {
      return await this.#rememberOrgId(orgIdFromQuery);
    }

    return await this.#loadOrgId();
  }

  async #ensureFragment(request?: Request, orgIdHint?: string) {
    const orgId = await this.#resolveOrgId(request, orgIdHint);
    if (!orgId) {
      return {
        fragment: null,
        resolution: {
          ok: false,
          missing: [],
          error: "Missing organisation id for Cloudflare Workers runtime.",
        } satisfies CloudflareWorkersConfigResolution,
      };
    }

    const resolution = resolveCloudflareWorkersConfig(this.#env, orgId);
    if (!resolution.ok) {
      return { fragment: null, resolution };
    }

    if (
      !this.#fragment ||
      !this.#fragmentConfig ||
      !configsEqual(this.#fragmentConfig, resolution.config)
    ) {
      this.#fragment = createCloudflareServer(resolution.config, this.#state);
      this.#fragmentConfig = resolution.config;
      this.#migrated = false;
      this.#dispatcher = null;
    }

    if (!this.#migrated && this.#fragment) {
      await migrate(this.#fragment);
      this.#migrated = true;
    }

    if (this.#fragment && !this.#dispatcher) {
      try {
        const dispatcherFactory = createDurableHooksProcessor([this.#fragment], {
          onProcessError: (error) => {
            console.error("Cloudflare Workers hook processor error", error);
          },
        });
        this.#dispatcher = dispatcherFactory(this.#state, this.#env);
      } catch (error) {
        console.warn("Cloudflare Workers hook processor disabled", error);
        this.#dispatcher = null;
      }
    }

    return { fragment: this.#fragment, resolution };
  }

  async alarm() {
    const ensured = await this.#ensureFragment();
    const dispatcher = this.#dispatcher;
    if (!ensured.fragment || !dispatcher?.alarm) {
      return;
    }

    await dispatcher.alarm();
  }

  async getHookQueue(input: CloudflareWorkersHookQueueInput): Promise<DurableHookQueueResponse> {
    const ensured = await this.#ensureFragment(undefined, input.orgId);
    if (!ensured.fragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return await loadDurableHookQueue(ensured.fragment, input);
  }

  async fetch(request: Request): Promise<Response> {
    const ensured = await this.#ensureFragment(request);
    if (!ensured.fragment) {
      return jsonResponse(
        {
          message:
            ensured.resolution.error ??
            "Cloudflare Workers is not configured for this environment.",
          code: "NOT_CONFIGURED",
          missing: ensured.resolution.ok ? [] : ensured.resolution.missing,
        },
        400,
      );
    }

    return ensured.fragment.handler(request);
  }
}
