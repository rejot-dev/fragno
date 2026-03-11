import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import type { DurableHooksDispatcherDurableObjectHandler } from "@fragno-dev/db/dispatchers/cloudflare-do";
import { createWorkflowLiveStateStore } from "@fragno-dev/workflows";
import { InMemoryFs } from "just-bash";
import { createPiRuntime, isValidPiToolId, type PiRuntimeFragments } from "@/fragno/pi";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import {
  resolvePiHarnesses,
  type PiConfigState,
  type PiHarnessConfig,
  type StoredPiConfig,
} from "@/fragno/pi-shared";

const CONFIG_KEY = "pi-config";
type PiHookQueueFragment = "pi" | "workflows";

type PiHookQueueOptions = DurableHookQueueOptions & {
  fragment?: PiHookQueueFragment;
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const maskSecret = (value?: string) => {
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const isConfigured = (config: StoredPiConfig | null) => {
  if (!config) {
    return false;
  }
  const hasKeys = Boolean(
    config.apiKeys.openai || config.apiKeys.anthropic || config.apiKeys.gemini,
  );
  const hasHarnesses = resolvePiHarnesses(config.harnesses).length > 0;
  return hasKeys && hasHarnesses;
};

const buildConfigState = (config: StoredPiConfig | null): PiConfigState => {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: isConfigured(config),
    config: {
      apiKeys: {
        openai: maskSecret(config.apiKeys.openai),
        anthropic: maskSecret(config.apiKeys.anthropic),
        gemini: maskSecret(config.apiKeys.gemini),
      },
      harnesses: resolvePiHarnesses(config.harnesses),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  };
};

const normalizeKey = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const normalizeHarnesses = (value: unknown): PiHarnessConfig[] | null => {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("Harnesses must be an array.");
  }

  const harnesses: PiHarnessConfig[] = value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Harness entry ${index + 1} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const systemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";
    const tools = Array.isArray(record.tools)
      ? record.tools.filter((tool): tool is string => typeof tool === "string")
      : [];

    if (!id) {
      throw new Error(`Harness entry ${index + 1} is missing an id.`);
    }
    if (id.includes("::")) {
      throw new Error(`Harness '${id}' cannot contain '::'.`);
    }
    if (!label) {
      throw new Error(`Harness '${id}' is missing a label.`);
    }
    if (!systemPrompt) {
      throw new Error(`Harness '${id}' is missing a system prompt.`);
    }

    for (const tool of tools) {
      if (!isValidPiToolId(tool)) {
        throw new Error(`Harness '${id}' references unknown tool '${tool}'.`);
      }
    }

    return {
      id,
      label,
      description: typeof record.description === "string" ? record.description.trim() : undefined,
      systemPrompt,
      tools,
      thinkingLevel: record.thinkingLevel as PiHarnessConfig["thinkingLevel"],
      steeringMode: record.steeringMode as PiHarnessConfig["steeringMode"],
      toolConfig: record.toolConfig,
    };
  });

  const ids = new Set<string>();
  for (const harness of harnesses) {
    if (ids.has(harness.id)) {
      throw new Error(`Harness id '${harness.id}' is duplicated.`);
    }
    ids.add(harness.id);
  }

  return harnesses;
};

export class Pi extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #piFragment: PiRuntimeFragments["piFragment"] | null = null;
  #workflowsFragment: PiRuntimeFragments["workflowsFragment"] | null = null;
  #dispatcher: DurableHooksDispatcherDurableObjectHandler | null = null;
  private initPromise: Promise<void>;
  #configFingerprint: string | null = null;
  #sessionFileSystems = new Map<string, InMemoryFs>();
  #liveWorkflowStates = createWorkflowLiveStateStore();

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.initPromise = state.blockConcurrencyWhile(async () => {
      const config = await this.#loadConfig();
      if (config && isConfigured(config)) {
        await this.#ensureRuntime(config);
      }
    });
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<StoredPiConfig>(CONFIG_KEY);
    return config ?? null;
  }

  #fingerprintConfig(config: StoredPiConfig) {
    try {
      return JSON.stringify({
        apiKeys: config.apiKeys,
        harnesses: resolvePiHarnesses(config.harnesses),
      });
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  async #buildRuntime(config: StoredPiConfig) {
    this.#liveWorkflowStates.clear();

    const runtime = createPiRuntime({
      config,
      state: this.#state,
      env: this.#env,
      sessionFileSystems: this.#sessionFileSystems,
      liveStateStore: this.#liveWorkflowStates,
    });

    await migrate(runtime.workflowsFragment);
    await migrate(runtime.piFragment);

    this.#piFragment = runtime.piFragment;
    this.#workflowsFragment = runtime.workflowsFragment;
    this.#dispatcher = runtime.dispatcher;
  }

  async #ensureRuntime(config: StoredPiConfig) {
    const nextFingerprint = this.#fingerprintConfig(config);
    if (
      this.#piFragment &&
      this.#workflowsFragment &&
      this.#configFingerprint === nextFingerprint
    ) {
      return;
    }

    this.#configFingerprint = nextFingerprint;
    this.initPromise = this.#state.blockConcurrencyWhile(async () => {
      await this.#buildRuntime(config);
    });

    await this.initPromise;
  }

  async alarm() {
    await this.initPromise;
    await this.#dispatcher?.alarm?.();
  }

  async getAdminConfig(): Promise<PiConfigState> {
    const config = await this.#loadConfig();
    return buildConfigState(config);
  }

  async setAdminConfig(payload: unknown): Promise<PiConfigState> {
    if (!payload || typeof payload !== "object") {
      throw new Error("Request body must be a JSON object.");
    }

    const record = payload as Record<string, unknown>;
    const existing = await this.#loadConfig();

    const apiKeysInput = record.apiKeys as Record<string, unknown> | undefined;
    const harnessesInput = record.harnesses;

    const openaiInput = apiKeysInput ? normalizeKey(apiKeysInput.openai) : "";
    const anthropicInput = apiKeysInput ? normalizeKey(apiKeysInput.anthropic) : "";
    const geminiInput = apiKeysInput ? normalizeKey(apiKeysInput.gemini) : "";

    const harnesses = normalizeHarnesses(harnessesInput);

    const now = new Date().toISOString();
    const stored: StoredPiConfig = {
      apiKeys: {
        openai: openaiInput || existing?.apiKeys.openai,
        anthropic: anthropicInput || existing?.apiKeys.anthropic,
        gemini: geminiInput || existing?.apiKeys.gemini,
      },
      harnesses: harnesses ?? existing?.harnesses ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.storage.put(CONFIG_KEY, stored);

    if (isConfigured(stored)) {
      await this.#ensureRuntime(stored);
    } else {
      this.#piFragment = null;
      this.#workflowsFragment = null;
      this.#dispatcher = null;
      this.#configFingerprint = this.#fingerprintConfig(stored);
      this.#liveWorkflowStates.clear();
    }

    return buildConfigState(stored);
  }

  async getHookQueue(options?: PiHookQueueOptions): Promise<DurableHookQueueResponse> {
    await this.initPromise;

    const config = await this.#loadConfig();
    if (!config || !isConfigured(config)) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    await this.#ensureRuntime(config);

    const targetFragmentId = options?.fragment === "workflows" ? "workflows" : "pi";
    const targetFragment =
      targetFragmentId === "workflows" ? this.#workflowsFragment : this.#piFragment;
    if (!targetFragment) {
      throw new Error(`Failed to load ${targetFragmentId} fragment runtime.`);
    }

    return await loadDurableHookQueue(targetFragment, {
      cursor: options?.cursor,
      pageSize: options?.pageSize,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initPromise;

    const config = await this.#loadConfig();
    if (!config || !isConfigured(config)) {
      return jsonResponse(
        { message: "Pi is not configured for this organisation.", code: "NOT_CONFIGURED" },
        400,
      );
    }

    await this.#ensureRuntime(config);

    const requestStartedAt = Date.now();
    const url = new URL(request.url);
    const path = url.pathname;
    const targetFragmentId = path.startsWith("/api/workflows") ? "workflows" : "pi";
    const targetFragment =
      targetFragmentId === "workflows" ? this.#workflowsFragment : this.#piFragment;
    if (!targetFragment) {
      throw new Error(
        `${targetFragmentId === "pi" ? "Pi" : "Workflows"} fragment failed to initialize.`,
      );
    }

    const isMessageSend =
      targetFragmentId === "pi" &&
      request.method === "POST" &&
      path.includes("/sessions/") &&
      path.endsWith("/messages");
    let messageSessionId: string | null = null;

    let proxyRequest = request;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const bodyText = await request.text();
      proxyRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: bodyText,
      });

      if (isMessageSend) {
        messageSessionId = path.split("/").at(-2) ?? null;
        let textLength: number | null = null;
        let payloadKeys: string[] | null = null;
        try {
          const payload = JSON.parse(bodyText) as Record<string, unknown>;
          payloadKeys = Object.keys(payload);
          if (typeof payload.text === "string") {
            textLength = payload.text.length;
          }
        } catch {
          // ignore payload parse errors
        }
        console.info("Pi DO: session message request", {
          sessionId: messageSessionId,
          path,
          textLength,
          payloadKeys,
        });
      }
    } else if (isMessageSend) {
      messageSessionId = path.split("/").at(-2) ?? null;
      console.info("Pi DO: session message request (no body)", {
        sessionId: messageSessionId,
        path,
      });
    }

    const response = await targetFragment.handler(proxyRequest);

    if (isMessageSend) {
      console.info("Pi DO: session message response", {
        sessionId: messageSessionId ?? path.split("/").at(-2) ?? null,
        path,
        status: response.status,
      });
    }

    if (isMessageSend) {
      console.info("Pi DO: session message request complete", {
        sessionId: messageSessionId ?? path.split("/").at(-2) ?? null,
        path,
        status: response.status,
        ms: Date.now() - requestStartedAt,
      });
    }

    return response;
  }
}
