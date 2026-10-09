import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { backofficeContextScopeSchema } from "@/backoffice-runtime/context";
import {
  BackofficeInternalRequestError,
  verifyAuthorizedBackofficeObjectRequest,
} from "@/backoffice-runtime/internal-object-request";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeContextScopeFromDurableObjectId,
  backofficeObjectScopeFromContextScope,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  piAgentObjectName,
  type PiAgent,
  type PiAvailableModel,
} from "@/fragno/pi-manager/pi-agent-contract";
import { createPiManagerFragment } from "@/fragno/pi-manager/pi-manager-fragment";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import {
  createPiDurableModels,
  listSupportedPiDurableModels,
} from "./lib/pi-durable-harness-options";
import {
  createScopedFragmentDurableObjectRuntime,
  type ScopedFragmentDurableObjectRuntime,
} from "./lib/scoped-fragment-durable-object";

type PiManagerFragment = ReturnType<typeof createPiManagerFragment>;

/** Shared scoped session directory; agent execution is handed to the runtime's agent namespace. */
export class InMemoryPiManagerObject extends RpcTarget {
  readonly #host: FragmentDurableObjectHost<BackofficeContextScope, PiManagerFragment>;
  readonly #scoped: ScopedFragmentDurableObjectRuntime<PiManagerFragment>;
  readonly #env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
  readonly #nowEpochMs: () => number;

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
    agent: (config: PiAgentConfig) => PiAgent;
    supportedAvailableModels: () => Promise<readonly PiAvailableModel[]>;
    nowEpochMs: () => number;
  }) {
    super();
    this.#env = env;
    this.#nowEpochMs = nowEpochMs;
    const kernel = new BackofficeKernel(runtime);
    this.#host = implementation.createFragmentHost({
      name: "PiManager",
      createRuntime: (scope) =>
        createPiManagerFragment(
          { scope, agent, supportedAvailableModels },
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

  async alarm(): Promise<void> {
    await this.#scoped.alarm();
  }
}

/** Singleton, organization, user, and project session directories match Automations scopes. */
export class PiManager extends DurableObject<CloudflareEnv> {
  readonly #object: InMemoryPiManagerObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const models = createPiDurableModels(env);
    this.#object = new InMemoryPiManagerObject({
      ...createCloudflareBackofficeObjectContext(state, env),
      agent: (config): PiAgent =>
        env.PI.get(env.PI.idFromName(piAgentObjectName(config))) as unknown as PiAgent,
      supportedAvailableModels: async () => await listSupportedPiDurableModels(models),
      nowEpochMs: Date.now,
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
