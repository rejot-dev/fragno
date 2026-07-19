import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { PiObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type { MasterFileSystem } from "@/files";
import { AUTOMATION_SYSTEM_ACTOR } from "@/fragno/automation/contracts";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { piConfigureInputSchema } from "@/fragno/backoffice-capabilities/capabilities/pi";
import {
  createPiOperationBillingEvent,
  PiOperationBillingEventValidationError,
} from "@/fragno/billing/pi";
import {
  createDurableHookRepositoryRpcTarget,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import {
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
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import {
  createBackofficeFragmentDurableObject,
  type BackofficeFragmentDurableObject,
  type BackofficeObjectState,
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
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
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
  scope: z.object({
    kind: z.literal("org"),
    orgId: z.string().trim().min(1, "Stored Pi config is missing an organisation id."),
  }),
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
  const hasScope = config.scope.kind === "org" && config.scope.orgId.trim().length > 0;
  const hasKeys = Boolean(
    config.apiKeys.openai || config.apiKeys.anthropic || config.apiKeys.gemini,
  );
  const hasHarnesses = resolvePiHarnesses(config.harnesses).length > 0;
  return hasScope && hasKeys && hasHarnesses;
};

const buildConfigState = (config: StoredPiConfig | null): PiConfigState => {
  if (!config) {
    return { configured: false };
  }

  return {
    configured: isConfigured(config),
    config: {
      orgId: config.scope.orgId,
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

export class InMemoryPiObject implements PiObject {
  readonly #env: Parameters<typeof createPiRuntime>[0]["env"];
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #host: BackofficeFragmentDurableObject<
    StoredPiConfig,
    StoredPiConfig,
    PiRuntimeFragments
  >;
  readonly #sessionFileSystems = new Map<string, Promise<MasterFileSystem>>();

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: Parameters<typeof createPiRuntime>[0]["env"];
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#host = createBackofficeFragmentDurableObject({
      name: "Pi",
      state,
      env,
      parseStored: (raw) => storedPiConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredPiConfig => isConfigured(stored),
      fingerprint: (config) =>
        JSON.stringify({
          scope: config.scope,
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
          match: ({ pathname }) =>
            pathname === "/api/pi-workflows" || pathname.startsWith("/api/pi-workflows/"),
          target: (runtime) => runtime.workflowsFragment,
        },
        { id: "pi", target: (runtime) => runtime.piFragment },
      ],
      outbox: {
        dispatch: async (item, { stored }) => {
          if (item.type !== "capability.configured") {
            return;
          }

          const { scope } = stored;
          await this.#runtimeServices.objects.automations.for(scope).ingestEvent({
            id: item.id,
            scope,
            source: "pi",
            eventType: "capability.configured",
            occurredAt: item.createdAt,
            payload: buildCapabilityConfiguredPayload(stored),
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: scope.orgId,
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
    const orgId = config.scope.orgId;

    const kernel = new BackofficeKernel({ objects: this.#runtimeServices.objects });
    const execution = {
      actor: { type: "object" as const, id: `pi:${orgId}`, organizationIds: [orgId] },
      scope: { kind: "org" as const, orgId },
    };
    const sessionFileSystemContext: PiSessionFileSystemContext = {
      orgId,
      objects: this.#runtimeServices.objects,
      kernel,
      execution,
      runtimeConfig: this.#runtimeServices.config,
    };

    return createPiRuntime({
      config,
      adapters: this.#runtimeServices.adapters,
      orgId,
      env: this.#env,
      codemode: {
        ...createPiCodemodeRuntime(this.#env),
        workflow: createRouteBackedAutomationWorkflowRuntime({
          object: this.#runtimeServices.objects.automations.forOrg(orgId),
          scope: { kind: "org", orgId },
        }),
      },
      sessionFileSystems: this.#sessionFileSystems,
      sessionFileSystemContext,
      bashCommandContext: createRouteBackedRuntimeContext({
        runtime: this.#runtimeServices,
        kernel,
        execution,
      }),
      onOperationCompleted: async (payload, context) => {
        let event: ReturnType<typeof createPiOperationBillingEvent>;
        try {
          event = createPiOperationBillingEvent({
            scope: config.scope,
            payload,
            hookId: context.hookId,
            idempotencyKey: context.idempotencyKey,
          });
        } catch (error) {
          if (error instanceof PiOperationBillingEventValidationError) {
            return;
          }
          throw error;
        }

        await this.#runtimeServices.objects.billing.forOrg(orgId).recordEvent(event);
      },
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
    const scope = { kind: "org" as const, orgId: normalizedOrgId };
    this.#host.assertSameScope(existing, scope);

    const now = new Date().toISOString();
    const parsedApiKeys = parsed.apiKeys ?? {};
    const stored: StoredPiConfig = {
      scope,
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
            id: crypto.randomUUID(),
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

export class Pi extends DurableObject<CloudflareEnv> implements PiObject {
  readonly #object: InMemoryPiObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryPiObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async alarm() {
    await this.#object.alarm();
  }

  async getAdminConfig(): Promise<PiConfigState> {
    return await this.#object.getAdminConfig();
  }

  async resetAdminConfig(): Promise<PiConfigState> {
    return await this.#object.resetAdminConfig();
  }

  async setAdminConfig(payload: unknown): Promise<PiConfigState> {
    return await this.#object.setAdminConfig(payload);
  }

  getDurableHookRepository(fragment?: PiHookFragment) {
    return this.#object.getDurableHookRepository(fragment);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
