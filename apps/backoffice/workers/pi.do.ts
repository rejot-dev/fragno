import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

import {
  backofficeContextScopesEqual,
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context-schema";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeActionRpcContext, PiObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import type { MasterFileSystem } from "@/files";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
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
  PI_SUPPORTED_MODELS,
  type PiApiKeys,
  type PiRuntimeState,
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

const storedPiConfigSchema: z.ZodType<StoredPiConfig> = z.object({
  scope: backofficeContextScopeSchema,
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

const piApiKeys = (env: CloudflareEnv): PiApiKeys => ({
  openai: env.OPENAI_API_KEY,
  anthropic: env.ANTHROPIC_API_KEY,
  gemini: env.GEMINI_API_KEY,
});

const buildRuntimeState = (env: CloudflareEnv): PiRuntimeState => {
  const apiKeys = piApiKeys(env);
  const modelCatalog = PI_SUPPORTED_MODELS.filter((option) => Boolean(apiKeys[option.provider]));
  return { configured: modelCatalog.length > 0, modelCatalog };
};

export class InMemoryPiObject implements PiObject {
  readonly #env: CloudflareEnv;
  readonly #state: BackofficeObjectState;
  readonly #runtimeServices: BackofficeRuntimeServices;
  readonly #kernel: BackofficeKernel;
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
    env: CloudflareEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#env = env;
    this.#state = state;
    this.#runtimeServices = runtime;
    this.#kernel = new BackofficeKernel(runtime);
    this.#host = createBackofficeFragmentDurableObject({
      name: "Pi",
      state,
      env,
      parseStored: (raw) => storedPiConfigSchema.parse(raw),
      isConfigured: (stored): stored is StoredPiConfig => stored !== null,
      fingerprint: (config) => JSON.stringify(config.scope),
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
    });

    void state.blockConcurrencyWhile(async () => {
      await this.#host.initializeFromStored(await this.#host.loadStored());
    });
  }

  #createRuntime(config: StoredPiConfig) {
    const { scope } = config;
    const scopeKey = backofficeContextScopeSinglePathSegment(scope);
    const execution =
      scope.kind === "system"
        ? createBackofficeSystemExecution(scope)
        : createBackofficeServiceExecution({
            scope,
            service: { type: "object", id: `pi:${scopeKey}` },
          });

    const sessionFileSystemContext: PiSessionFileSystemContext = {
      scope,
      objects: this.#runtimeServices.objects,
      kernel: this.#kernel,
      execution,
      runtimeConfig: this.#runtimeServices.config,
    };

    return createPiRuntime({
      config,
      apiKeys: piApiKeys(this.#env),
      adapters: this.#runtimeServices.adapters,
      codemode: {
        ...createPiCodemodeRuntime(this.#env),
        workflow: createRouteBackedAutomationWorkflowRuntime({
          object: this.#runtimeServices.objects.automations.for(scope),
        }),
      },
      sessionFileSystems: this.#sessionFileSystems,
      sessionFileSystemContext,
      runtimeToolContext: (sessionExecution) =>
        createRouteBackedRuntimeContext({
          runtime: this.#runtimeServices,
          kernel: this.#kernel,
          execution: sessionExecution,
        }),
      onOperationCompleted: async (payload, context) => {
        let event: ReturnType<typeof createPiOperationBillingEvent>;
        try {
          event = createPiOperationBillingEvent({
            scope: config.scope,
            payload,
            hookId: context.hookId.toString(),
            idempotencyKey: context.idempotencyKey,
          });
        } catch (error) {
          if (error instanceof PiOperationBillingEventValidationError) {
            return;
          }
          throw error;
        }

        // Billing objects are organisation-owned, so only scopes with an owning organisation emit usage events.
        if (scope.kind === "org" || scope.kind === "project") {
          await this.#runtimeServices.objects.billing.forOrg(scope.orgId).recordEvent(event, {
            propagationContext: context.capturePropagationContext(),
          });
        }
      },
    });
  }

  async alarm() {
    await this.#host.alarm();
  }

  async getRuntimeState(scope: unknown): Promise<PiRuntimeState> {
    const parsedScope = backofficeContextScopeSchema.parse(scope);
    await this.#ensureInitialized(parsedScope);
    return buildRuntimeState(this.#env);
  }

  async #ensureInitialized(scope: StoredPiConfig["scope"]): Promise<void> {
    const existing = await this.#host.loadStored();
    this.#host.assertSameScope(existing, scope);
    if (existing) {
      return;
    }
    await this.#state.blockConcurrencyWhile(async () => {
      const current = await this.#host.loadStored();
      this.#host.assertSameScope(current, scope);
      if (!current) {
        await this.#host.storeAndInitialize({ scope });
      }
    });
  }

  async getDurableHookRepository(scope: unknown, fragment?: PiHookFragment) {
    const parsedScope = backofficeContextScopeSchema.parse(scope);
    await this.#ensureInitialized(parsedScope);
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

  async fetchWithContext(request: Request, context: BackofficeActionRpcContext): Promise<Response> {
    await this.#ensureInitialized(context.execution.scope);
    const { stored } = this.#host.requireConfigured("Pi runtime is not ready.");
    if (!backofficeContextScopesEqual(stored.scope, context.execution.scope)) {
      throw new Error("Backoffice object method scope does not match object address scope.");
    }

    return await this.#host.fetch(request, {
      propagationContext: context.propagationContext,
      requestContext: context.execution,
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

  async getRuntimeState(scope: unknown): Promise<PiRuntimeState> {
    return await this.#object.getRuntimeState(scope);
  }

  async getDurableHookRepository(scope: unknown, fragment?: PiHookFragment) {
    return await this.#object.getDurableHookRepository(scope, fragment);
  }

  async fetchWithContext(request: Request, context: BackofficeActionRpcContext): Promise<Response> {
    return await this.#object.fetchWithContext(request, context);
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }
}
