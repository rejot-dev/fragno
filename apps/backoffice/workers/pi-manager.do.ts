import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
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
import { createPiModels, listAvailablePiModels } from "@/fragno/pi/agent/pi-models";
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
  readonly #config: Pick<PiManagerConfig, "agent" | "supportedAvailableModels">;

  constructor({
    state,
    env,
    runtime,
    implementation,
    agent,
    supportedAvailableModels,
    nowEpochMs,
  }: {
    state: BackofficeObjectState;
    env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    agent: (address: PiAgentAddress) => PiAgent;
    supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
    nowEpochMs: () => number;
  }) {
    super();
    this.#env = env;
    this.#nowEpochMs = nowEpochMs;
    this.#config = { agent, supportedAvailableModels };
    const kernel = new BackofficeKernel(runtime);
    this.#host = implementation.createFragmentHost({
      name: "PiManager",
      createRuntime: (scope) =>
        createPiManagerFragment(
          {
            scope,
            agent,
            supportedAvailableModels,
          },
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

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
