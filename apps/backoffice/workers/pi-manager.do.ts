import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

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
import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentAddress,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  createPiClassifier,
  createPiModels,
  listAvailablePiModels,
  type PiClassifier,
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

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type PiManagerFragment = ReturnType<typeof createPiManagerFragment>;

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

  constructor({
    state,
    env,
    runtime,
    implementation,
    agent,
    supportedAvailableModels,
    classifier,
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
    nowEpochMs: () => number;
  }) {
    super();
    this.#env = env;
    this.#nowEpochMs = nowEpochMs;
    this.#runtime = runtime;
    this.#classifier = classifier;
    this.#config = {
      agent,
      supportedAvailableModels,
      queueChannel: createPiAgentQueueChannel(),
      billing: (organizationId) => runtime.objects.billing.forOrg(organizationId).commands,
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
    billingOrganizationId,
  }: Parameters<PiManagerObject["classify"]>[0]): ReturnType<PiManagerObject["classify"]> {
    if (!this.#classifier) {
      throw new Error("MODELS_CLASSIFY_UNAVAILABLE: no classifier is configured.");
    }
    const scope = this.#scoped.requireOwnerScope();
    const billed = this.#runtime.config.bindings.billing;
    const payer = backofficeScopeOrganization(scope)?.orgId ?? billingOrganizationId;
    if (billed && payer === null) {
      return { type: "billing-owner-required" };
    }
    const result = await this.#classifier(request);
    // A failed classification can still report the tokens the provider charged for.
    const counters = piBillingCountersFromUsage(result.usage ? [result.usage] : []);
    if (billed && payer !== null && hasPiBillingUsage(counters)) {
      const fragment = await this.#scoped.getRuntime();
      await fragment.callServices(() =>
        fragment.services.recordClassificationUsage({
          organizationId: payer,
          event: {
            id: `models-classify:${crypto.randomUUID()}`,
            scope,
            source: "models",
            eventType: "classify.completed",
            occurredAt: new Date(this.#nowEpochMs()).toISOString(),
            measurements: createPiBillingMeasurements(counters),
            metadata: { provider: result.provider, model: result.model },
          },
        }),
      );
    }
    if (result.stopReason !== "stop") {
      throw new Error(`MODELS_CLASSIFY_FAILED: ${result.errorMessage ?? result.stopReason}`);
    }
    return { type: "classified", answers: result.answers };
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
      classifier: createPiClassifier(env),
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

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
