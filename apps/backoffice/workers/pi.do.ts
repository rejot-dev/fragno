import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import type { MasterFileSystem } from "@/files";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { piConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/pi";
import {
  createDurableHookRepositoryRpcTarget,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import {
  createPiBashCommandContext,
  createPiRuntime,
  type PiRuntimeFragments,
  type PiSessionFileSystemContext,
} from "@/fragno/pi/pi";
import { createPiCodemodeRuntime } from "@/fragno/pi/pi-codemode";
import {
  PI_MODEL_CATALOG,
  PI_TOOL_IDS,
  resolvePiHarnesses,
  type PiConfigState,
  type PiHarnessConfig,
  type PiThinkingLevel,
  type PiSteeringMode,
  type StoredPiConfig,
} from "@/fragno/pi/pi-shared";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
} from "./lib/backoffice-fragment-durable-object";

type PiHookFragment = "pi" | "workflows";

type PiHookQueueOptions = DurableHookQueueOptions & {
  fragment?: PiHookFragment;
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

const setAdminConfigInputSchema = piConfigureInputSchema.extend({
  orgId: z.string().trim().min(1, "Pi configuration requires an organisation id."),
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

const hasOwn = (record: object | null | undefined, key: PropertyKey) =>
  Boolean(record && Object.prototype.hasOwnProperty.call(record, key));

const maskSecret = (value?: string) => {
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return "••••";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};

const buildCapabilityConfiguredPayload = (config: StoredPiConfig) => ({
  capabilityId: "pi",
  capabilityLabel: "Pi",
  harnesses: resolvePiHarnesses(config.harnesses).map((harness) => ({
    id: harness.id,
    label: harness.label,
    description: harness.description,
    tools: harness.tools,
  })),
  modelCatalog: PI_MODEL_CATALOG.filter((option) => Boolean(config.apiKeys[option.provider])),
});

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
  #host: BackofficeFragmentDurableObject<StoredPiConfig, StoredPiConfig, PiRuntimeFragments>;
  #sessionFileSystems = new Map<string, Promise<MasterFileSystem>>();

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Pi",
      state,
      env,
      parseStored: (raw) => storedPiConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredPiConfig => isConfigured(stored),
      fingerprint: (config) =>
        JSON.stringify({
          orgId: config.orgId,
          apiKeys: config.apiKeys,
          harnesses: resolvePiHarnesses(config.harnesses),
        }),
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
      outbox: {
        dispatch: async (item, { env, stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          await env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(stored.orgId)).ingestEvent({
            id: item.id,
            orgId: stored.orgId,
            source: "pi",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: buildCapabilityConfiguredPayload(stored),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: stored.orgId,
              capabilityId: "pi",
            },
          });
        },
      },
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  #createRuntime(config: StoredPiConfig) {
    const orgId = this.#host.getStoredOrgId(config);
    if (!orgId) {
      throw new Error("Stored Pi config is missing an organisation id.");
    }

    const sessionFileSystemContext: PiSessionFileSystemContext = {
      orgId,
      env: this.#env,
    };

    return createPiRuntime({
      config,
      state: this.#state,
      env: this.#env,
      codemode: {
        ...createPiCodemodeRuntime(this.#env),
        workflow: createRouteBackedAutomationWorkflowRuntime({ env: this.#env, orgId }),
      },
      sessionFileSystems: this.#sessionFileSystems,
      sessionFileSystemContext,
      bashCommandContext: createPiBashCommandContext({
        env: this.#env,
        orgId,
      }),
    });
  }

  async alarm() {
    await this.#host.alarm();
  }

  async getAdminConfig(): Promise<PiConfigState> {
    const config = await this.#host.loadStored();
    return buildConfigState(config);
  }

  async resetAdminConfig(): Promise<PiConfigState> {
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#host.clearConfig();
    });
    return buildConfigState(null);
  }

  async setAdminConfig(payload: unknown): Promise<PiConfigState> {
    const parsed = setAdminConfigInputSchema.parse(payload);
    const normalizedOrgId = parsed.orgId;

    const existing = await this.#host.loadStored();
    this.#host.assertSameOrg(existing, normalizedOrgId);

    const now = new Date().toISOString();
    const parsedApiKeys = parsed.apiKeys ?? {};
    const stored: StoredPiConfig = {
      orgId: normalizedOrgId,
      apiKeys: {
        openai: hasOwn(parsedApiKeys, "openai") ? parsedApiKeys.openai : existing?.apiKeys.openai,
        anthropic: hasOwn(parsedApiKeys, "anthropic")
          ? parsedApiKeys.anthropic
          : existing?.apiKeys.anthropic,
        gemini: hasOwn(parsedApiKeys, "gemini") ? parsedApiKeys.gemini : existing?.apiKeys.gemini,
      },
      harnesses:
        parsed.harnesses === undefined
          ? (existing?.harnesses ?? [])
          : toStoredHarnesses(parsed.harnesses),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      await this.#state.blockConcurrencyWhile(async () => {
        const parsedStored = storedPiConfigSchema.parse(stored);
        await this.#host.storeAndInitialize(parsedStored);

        if (isConfigured(parsedStored)) {
          await this.#host.dispatch({
            id: `pi:capability.configured:${normalizedOrgId}:${now}`,
            type: "capability.configured",
            createdAt: now,
          });
        }
      });
    } catch (error) {
      console.log("Migration failed", { error });
      throw new Error("Failed to migrate Pi schema.");
    }

    return buildConfigState(stored);
  }

  getDurableHookRepository(fragment?: PiHookFragment) {
    const repository = this.#host.getDurableHookRepository<PiHookQueueOptions>(
      ({ runtime }, queueOptions) =>
        queueOptions?.fragment === "workflows" ? runtime.workflowsFragment : runtime.piFragment,
    );

    const withFragment = (options?: PiHookQueueOptions) =>
      hookQueueOptionsSchema.parse({ ...options, fragment: options?.fragment ?? fragment }) ?? {};

    return createDurableHookRepositoryRpcTarget({
      getHookQueue: async (options?: PiHookQueueOptions) =>
        await repository.getHookQueue(withFragment(options)),
      getHook: async (hookId: string, options?: PiHookQueueOptions) =>
        await repository.getHook(hookId, withFragment(options)),
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#host.fetch(request);
  }
}
