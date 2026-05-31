import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { MasterFileSystem } from "@/files";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import {
  createPiBashCommandContext,
  createPiRuntime,
  type PiRuntimeFragments,
  type PiSessionFileSystemContext,
} from "@/fragno/pi/pi";
import {
  PI_TOOL_IDS,
  resolvePiHarnesses,
  type PiConfigState,
  type PiHarnessConfig,
  type PiThinkingLevel,
  type PiSteeringMode,
  type StoredPiConfig,
} from "@/fragno/pi/pi-shared";

const CONFIG_KEY = "pi-config";
type PiHookQueueFragment = "pi" | "workflows";

type PiHookQueueOptions = DurableHookQueueOptions & {
  fragment?: PiHookQueueFragment;
};

type PiRuntime =
  | { configured: false }
  | {
      configured: true;
      stored: StoredPiConfig;
      config: StoredPiConfig;
      fragments: PiRuntimeFragments;
    };

const apiKeySchema = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional();

const steeringModeSchema = z.enum(["all", "one-at-a-time"]).optional();

const harnessSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "Harness id is required.")
    .refine((value) => !value.includes("::"), {
      message: "Harness id cannot contain '::'.",
    }),
  label: z.string().trim().min(1, "Harness label is required."),
  description: z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .optional(),
  systemPrompt: z.string().trim().min(1, "Harness system prompt is required."),
  tools: z.array(z.enum(PI_TOOL_IDS)).default([]),
  thinkingLevel: thinkingLevelSchema,
  steeringMode: steeringModeSchema,
  toolConfig: z.unknown().optional(),
});

const harnessesSchema = z.array(harnessSchema).superRefine((harnesses, context) => {
  const ids = new Set<string>();
  for (const [index, harness] of harnesses.entries()) {
    if (ids.has(harness.id)) {
      context.addIssue({
        code: "custom",
        message: `Harness id '${harness.id}' is duplicated.`,
        path: [index, "id"],
      });
      continue;
    }
    ids.add(harness.id);
  }
});

const storedPiConfigSchema: z.ZodType<StoredPiConfig> = z.object({
  orgId: z.string().trim().min(1, "Stored Pi config is missing an organisation id."),
  apiKeys: z.object({
    openai: apiKeySchema,
    anthropic: apiKeySchema,
    gemini: apiKeySchema,
  }),
  harnesses: harnessesSchema,
  createdAt: z.string().trim().min(1, "Stored Pi config is missing createdAt."),
  updatedAt: z.string().trim().min(1, "Stored Pi config is missing updatedAt."),
});

const setAdminConfigInputSchema = z.object({
  orgId: z.string().trim().min(1, "Pi configuration requires an organisation id."),
  apiKeys: z
    .object({
      openai: apiKeySchema,
      anthropic: apiKeySchema,
      gemini: apiKeySchema,
    })
    .optional(),
  harnesses: harnessesSchema.optional(),
});

const hookQueueOptionsSchema = z
  .object({
    fragment: z.enum(["pi", "workflows"]).optional(),
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

const buildOrgIdMismatchMessage = (expectedOrgId: string, orgId: string) =>
  `Pi Durable Object is bound to organisation "${expectedOrgId}" and cannot serve requests for organisation "${orgId}".`;

const buildOrgIdMismatchResponse = (expectedOrgId: string, orgId: string) =>
  Response.json(
    {
      message: buildOrgIdMismatchMessage(expectedOrgId, orgId),
      code: "ORG_ID_MISMATCH",
      expectedOrgId,
      orgId,
    },
    { status: 409 },
  );

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
  const hasOrgId = typeof config.orgId === "string" && config.orgId.trim().length > 0;
  const hasKeys = Boolean(
    config.apiKeys.openai || config.apiKeys.anthropic || config.apiKeys.gemini,
  );
  const hasHarnesses = resolvePiHarnesses(config.harnesses).length > 0;
  return hasOrgId && hasKeys && hasHarnesses;
};

const buildConfigState = (config: StoredPiConfig | null): PiConfigState => {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: isConfigured(config),
    config: {
      orgId: config.orgId,
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

const toStoredHarness = (harness: z.infer<typeof harnessSchema>): PiHarnessConfig => ({
  id: harness.id,
  label: harness.label,
  description: harness.description,
  systemPrompt: harness.systemPrompt,
  tools: harness.tools,
  thinkingLevel: harness.thinkingLevel as PiThinkingLevel | undefined,
  steeringMode: harness.steeringMode as PiSteeringMode | undefined,
  toolConfig: harness.toolConfig,
});

const toStoredHarnesses = (harnesses: z.infer<typeof harnessesSchema>) =>
  harnesses.map(toStoredHarness);

export class Pi extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #host: FragmentDurableObjectHost<StoredPiConfig, PiRuntimeFragments>;
  #runtime: PiRuntime = { configured: false };
  #sessionFileSystems = new Map<string, Promise<MasterFileSystem>>();

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createFragmentDurableObjectHost<CloudflareEnv, StoredPiConfig, PiRuntimeFragments>(
      {
        name: "Pi",
        state,
        env,
        createRuntime: (config) => this.#createRuntime(config),
        getMigrationFragments: (runtime) => [runtime.workflowsFragment, runtime.piFragment],
        hostRuntime: (runtime, { hostFragment }) => ({
          ...runtime,
          workflowsFragment: hostFragment(runtime.workflowsFragment),
          piFragment: hostFragment(runtime.piFragment),
        }),
        mounts: [
          {
            id: "workflows",
            match: ({ pathname }) => pathname.startsWith("/api/workflows"),
            target: (runtime) => runtime.workflowsFragment,
          },
          { id: "pi", target: (runtime) => runtime.piFragment },
        ],
        onProcessError: (error) => {
          console.error("Pi hook processor error", error);
        },
        onDispatcherError: (error) => {
          console.warn("Pi hook processor disabled", error);
        },
      },
    );

    void state.blockConcurrencyWhile(async () => {
      try {
        const stored = await this.#loadConfig();
        if (!stored || !isConfigured(stored)) {
          this.#runtime = { configured: false };
          return;
        }

        this.#getStoredOrgId(stored, { required: true });
        const fragments = await this.#host.initialize(stored);
        this.#runtime = {
          configured: true,
          stored,
          config: stored,
          fragments,
        };
      } catch (error) {
        console.log("Migration failed", { error });
        throw error;
      }
    });
  }

  async #loadConfig() {
    const config = await this.#state.storage.get<unknown>(CONFIG_KEY);
    if (config === undefined || config === null) {
      return null;
    }

    return storedPiConfigSchema.parse(config);
  }

  #getStoredOrgId(config: StoredPiConfig | null, options: { required: true }): string;
  #getStoredOrgId(config: StoredPiConfig | null, options?: { required?: false }): string | null;
  #getStoredOrgId(config: StoredPiConfig | null, options: { required?: boolean } = {}) {
    const storedOrgId = typeof config?.orgId === "string" ? config.orgId.trim() : "";
    if (storedOrgId) {
      return storedOrgId;
    }

    if (options.required) {
      throw new Error("Stored Pi config is missing an organisation id.");
    }

    return null;
  }

  #assertRequestOrgIdMatchesConfig(request: Request, config: StoredPiConfig): Response | null {
    const expectedOrgId = this.#getStoredOrgId(config);
    if (!expectedOrgId) {
      return null;
    }

    const requestOrgId = new URL(request.url).searchParams.get("orgId")?.trim();
    if (!requestOrgId) {
      return null;
    }

    if (requestOrgId !== expectedOrgId) {
      return buildOrgIdMismatchResponse(expectedOrgId, requestOrgId);
    }

    return null;
  }

  #createRuntime(config: StoredPiConfig) {
    const orgId = this.#getStoredOrgId(config, { required: true });

    const sessionFileSystemContext: PiSessionFileSystemContext = {
      orgId,
      env: this.#env,
    };

    return createPiRuntime({
      config,
      state: this.#state,
      env: this.#env,
      sessionFileSystems: this.#sessionFileSystems,
      sessionFileSystemContext,
      bashCommandContext: createPiBashCommandContext({
        env: this.#env,
        orgId,
      }),
    });
  }

  async #setRuntimeFromStoredConfig(stored: StoredPiConfig | null) {
    if (!stored || !isConfigured(stored)) {
      this.#runtime = { configured: false };
      return;
    }

    this.#getStoredOrgId(stored, { required: true });
    const fragments = await this.#host.initialize(stored);
    this.#runtime = {
      configured: true,
      stored,
      config: stored,
      fragments,
    };
  }

  #getConfiguredRuntime() {
    return this.#runtime.configured ? this.#runtime : null;
  }

  #getConfiguredRuntimeOrThrow() {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      throw new Error("Pi is unavailable.");
    }

    return runtime;
  }

  async alarm() {
    await this.#host.alarm();
  }

  async getAdminConfig(): Promise<PiConfigState> {
    const config = await this.#loadConfig();
    return buildConfigState(config);
  }

  async setAdminConfig(payload: unknown): Promise<PiConfigState> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const normalizedOrgId = parsed.orgId;

    const existing = await this.#loadConfig();
    const existingOrgId = this.#getStoredOrgId(existing);
    if (existingOrgId && existingOrgId !== normalizedOrgId) {
      throw new Error(buildOrgIdMismatchMessage(existingOrgId, normalizedOrgId));
    }

    const now = new Date().toISOString();
    const stored: StoredPiConfig = {
      orgId: normalizedOrgId,
      apiKeys: {
        openai: parsed.apiKeys?.openai || existing?.apiKeys.openai,
        anthropic: parsed.apiKeys?.anthropic || existing?.apiKeys.anthropic,
        gemini: parsed.apiKeys?.gemini || existing?.apiKeys.gemini,
      },
      harnesses:
        parsed.harnesses === undefined
          ? (existing?.harnesses ?? [])
          : toStoredHarnesses(parsed.harnesses),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.#state.storage.put(CONFIG_KEY, storedPiConfigSchema.parse(stored));

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        await this.#setRuntimeFromStoredConfig(stored);
      });
    } catch (error) {
      console.log("Migration failed", { error });
      throw new Error("Failed to migrate Pi schema.");
    }

    return buildConfigState(stored);
  }

  async getHookQueue(options?: PiHookQueueOptions): Promise<DurableHookQueueResponse> {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    const configuredRuntime = this.#getConfiguredRuntimeOrThrow();
    const parsedOptions = hookQueueOptionsSchema.parse(options) ?? {};
    const targetFragmentId = parsedOptions.fragment === "workflows" ? "workflows" : "pi";
    const targetFragment =
      targetFragmentId === "workflows"
        ? configuredRuntime.fragments.workflowsFragment
        : configuredRuntime.fragments.piFragment;

    return await loadDurableHookQueue(targetFragment, {
      cursor: parsedOptions.cursor,
      pageSize: parsedOptions.pageSize,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const runtime = this.#getConfiguredRuntime();
    if (!runtime) {
      return Response.json(
        { message: "Pi is not configured for this organisation.", code: "NOT_CONFIGURED" },
        { status: 400 },
      );
    }

    const orgIdMismatchResponse = this.#assertRequestOrgIdMatchesConfig(request, runtime.stored);
    if (orgIdMismatchResponse) {
      return orgIdMismatchResponse;
    }

    return this.#host.fetch(runtime.fragments, request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
