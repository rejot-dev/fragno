import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { Usage } from "@earendil-works/pi-ai";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import {
  BackofficeInternalRequestError,
  verifyAuthorizedBackofficeObjectRequest,
} from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
  type PiManagerObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BillingMeasurementInput } from "@/fragno/billing/contracts";
import { usageBillingForScope, type UsageBilling } from "@/fragno/billing/usage-billing";
import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentAddress,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  createPiClassifier,
  createPiImageGenerator,
  createPiModels,
  listAvailablePiModels,
  type PiClassifier,
  type PiImageGenerator,
} from "@/fragno/pi/agent/pi-models";
import {
  createPiBillingMeasurements,
  hasPiBillingUsage,
  piBillingCountersFromUsage,
} from "@/fragno/pi/extensions/billing/usage-counters";
import { createPiAgentQueueChannel } from "@/fragno/pi/manager/pi-agent-queue";
import type { PiManagerConfig } from "@/fragno/pi/manager/pi-manager-definition";
import {
  createPiManagerFragment,
  reportPiAgentTurnSettled,
} from "@/fragno/pi/manager/pi-manager-fragment";
import { base64ToBytes } from "@/lib/base64";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type PiManagerFragment = ReturnType<typeof createPiManagerFragment>;

/** Each delivered result counts once, next to the tokens it cost. */
const MODEL_CALL_COUNTS = {
  classify: { meter: "models.classifications", unit: "classification", quantity: 1 },
  generateImage: { meter: "models.images", unit: "image", quantity: 1 },
} as const satisfies Record<string, BillingMeasurementInput>;

/** Shared scoped agent directory; agent execution is handed to the runtime's agent namespace. */
export class InMemoryPiManagerObject extends RpcTarget implements PiManagerObject {
  readonly #host: FragmentDurableObjectHost<BackofficeContextScope, PiManagerFragment>;
  readonly #scoped: ScopedFragmentDurableObjectRuntime<PiManagerFragment>;
  readonly #env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
  readonly #nowEpochMs: () => number;
  readonly #config: Pick<
    PiManagerConfig,
    "agent" | "supportedAvailableModels" | "queueChannel" | "billing"
  >;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #classifier: PiClassifier | null;
  readonly #imageGenerator: PiImageGenerator | null;

  constructor({
    state,
    env,
    runtime,
    implementation,
    agent,
    supportedAvailableModels,
    classifier,
    imageGenerator,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    agent: (address: PiAgentAddress) => PiAgent;
    supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
    /** Null without classifier credentials, so `classify` rejects. */
    classifier: PiClassifier | null;
    /** Null without image generation credentials, so `generateImage` rejects. */
    imageGenerator: PiImageGenerator | null;
    nowEpochMs: () => number;
  }) {
    super();
    this.#env = env;
    this.#nowEpochMs = nowEpochMs;
    this.#runtime = runtime;
    this.#classifier = classifier;
    this.#imageGenerator = imageGenerator;
    this.#config = {
      agent,
      supportedAvailableModels,
      queueChannel: createPiAgentQueueChannel(),
      billing: (scope) => usageBillingForScope(runtime, scope),
    };
    const kernel = new BackofficeKernel(runtime);
    this.#host = implementation.createFragmentHost({
      name: "PiManager",
      createRuntime: (scope) =>
        createPiManagerFragment(
          { scope, ...this.#config },
          {
            databaseAdapter: implementation.fragmentDatabase.adapters.createAdapter({
              kind: "pi-manager",
            }),
            transactionInstrumentation: implementation.fragmentDatabase.transactionInstrumentation,
            mountRoute: "/api/pi-manager",
          },
          kernel,
        ),
    });
    this.#scoped = createScopedFragmentDurableObjectRuntime({
      name: "PiManager",
      state,
      ownerScope: backofficeContextScopeFromDurableObjectId(state.id, "PI_MANAGER"),
      host: this.#host,
      scopeSchema: backofficeContextScopeSchema,
      createSource: (scope) => scope,
    });
    void state.blockConcurrencyWhile(() => this.#scoped.initializeFromOwnerScope());
  }

  async warm(): Promise<void> {
    // Pages in a scope usually reach its built-in assistant, so it starts with its directory.
    await this.#config
      .agent({ scope: this.#scoped.requireOwnerScope(), agentName: "assistant" })
      .warm();
  }

  async fetch(request: Request): Promise<Response> {
    const scope = this.#scoped.requireOwnerScope();
    try {
      const verified = await verifyAuthorizedBackofficeObjectRequest({
        request,
        address: { binding: "PI_MANAGER", scope: backofficeObjectScopeFromContextScope(scope) },
        env: this.#env,
        nowEpochMs: this.#nowEpochMs(),
      });
      return await this.#host.fetch(await this.#scoped.getRuntime(), verified.request, {
        propagationContext: verified.context.propagationContext,
        requestContext: {
          execution: verified.context.execution,
        },
      });
    } catch (cause) {
      if (cause instanceof BackofficeInternalRequestError) {
        return Response.json(
          { code: "INVALID_INTERNAL_CONTEXT", message: cause.message },
          { status: 401 },
        );
      }
      throw cause;
    }
  }

  async reportSettledTurn(input: { agentName: string; requestId: string }): Promise<void> {
    await reportPiAgentTurnSettled(await this.#scoped.getRuntime(), this.#config, input);
  }

  async classify({
    request,
  }: Parameters<PiManagerObject["classify"]>[0]): ReturnType<PiManagerObject["classify"]> {
    if (!this.#classifier) {
      throw new Error("MODELS_CLASSIFY_UNAVAILABLE: no classifier is configured.");
    }
    // A customer scope without Billing fails here, before the provider charges for the call.
    const billing = usageBillingForScope(this.#runtime, this.#scoped.requireOwnerScope());
    const result = await this.#classifier(request);
    await this.#recordModelUsage(billing, {
      operation: "classify",
      succeeded: result.stopReason === "stop",
      ...result,
    });
    if (result.stopReason !== "stop") {
      throw new Error(`MODELS_CLASSIFY_FAILED: ${result.errorMessage ?? result.stopReason}`);
    }
    return { answers: result.answers };
  }

  async generateImage({
    request,
  }: Parameters<PiManagerObject["generateImage"]>[0]): ReturnType<
    PiManagerObject["generateImage"]
  > {
    if (!this.#imageGenerator) {
      throw new Error("MODELS_GENERATE_IMAGE_UNAVAILABLE: no image generator is configured.");
    }
    const billing = usageBillingForScope(this.#runtime, this.#scoped.requireOwnerScope());
    const result = await this.#imageGenerator(request);
    const image = result.output.find((part) => part.type === "image");
    const succeeded = result.stopReason === "stop" && image !== undefined;
    await this.#recordModelUsage(billing, { operation: "generateImage", succeeded, ...result });
    if (!succeeded) {
      throw new Error(
        `MODELS_GENERATE_IMAGE_FAILED: ${result.errorMessage ?? (image ? result.stopReason : "the model returned no image")}`,
      );
    }
    return { bytes: base64ToBytes(image.data) };
  }

  /** Commits the usage for durable delivery; a failed call can still report tokens it was charged. */
  async #recordModelUsage(
    billing: UsageBilling,
    call: {
      operation: keyof typeof MODEL_CALL_COUNTS;
      succeeded: boolean;
      provider: string;
      model: string;
      usage?: Usage;
    },
  ): Promise<void> {
    const counters = piBillingCountersFromUsage(call.usage ? [call.usage] : []);
    if (billing.kind === "system" || (!call.succeeded && !hasPiBillingUsage(counters))) {
      return;
    }
    const fragment = await this.#scoped.getRuntime();
    await fragment.callServices(() =>
      fragment.services.recordModelUsage({
        event: {
          id: `models-${call.operation}:${crypto.randomUUID()}`,
          scope: this.#scoped.requireOwnerScope(),
          source: "models",
          eventType: `${call.operation}.${call.succeeded ? "completed" : "failed"}`,
          occurredAt: new Date(this.#nowEpochMs()).toISOString(),
          measurements: [
            ...createPiBillingMeasurements(counters),
            ...(call.succeeded ? [MODEL_CALL_COUNTS[call.operation]] : []),
          ],
          metadata: { provider: call.provider, model: call.model },
        },
      }),
    );
  }

  async alarm(): Promise<void> {
    await this.#scoped.alarm();
  }
}

/** Singleton, organization, user, and project agent directories match Automations scopes. */
export class PiManager extends DurableObject<CloudflareEnv> implements PiManagerObject {
  readonly #object: InMemoryPiManagerObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const models = createPiModels(env);
    this.#object = new InMemoryPiManagerObject({
      ...createCloudflareBackofficeObjectContext(state, env),
      agent: (config): PiAgent =>
        env.PI.get(env.PI.idFromName(piAgentObjectName(config))) as unknown as PiAgent,
      supportedAvailableModels: async () => await listAvailablePiModels(models),
      classifier: createPiClassifier(env, fetch),
      imageGenerator: createPiImageGenerator(env, fetch),
      nowEpochMs: Date.now,
    });
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async reportSettledTurn(input: { agentName: string; requestId: string }): Promise<void> {
    await this.#object.reportSettledTurn(input);
  }

  async classify(
    input: Parameters<PiManagerObject["classify"]>[0],
  ): ReturnType<PiManagerObject["classify"]> {
    return await this.#object.classify(input);
  }

  async generateImage(
    input: Parameters<PiManagerObject["generateImage"]>[0],
  ): ReturnType<PiManagerObject["generateImage"]> {
    return await this.#object.generateImage(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
