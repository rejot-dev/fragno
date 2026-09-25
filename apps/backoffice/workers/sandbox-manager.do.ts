import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type SandboxManagerObject,
} from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import type {
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxLifecycleEvent,
  SandboxProvider,
} from "@/fragno/sandbox-manager/contracts";
import { createSandboxManagerRuntime } from "@/fragno/sandbox-manager/sandbox-manager";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";
import type { SandboxCommandResult, SandboxRuntimeProvider } from "@/sandbox/contracts";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import { cloudflareDatabaseTransactionInstrumentation } from "./lib/cloudflare-database-transaction-instrumentation";
import { cloudflareDurableHooksInstrumentation } from "./lib/cloudflare-durable-hooks-instrumentation";

function buildSandboxAutomationEvent(
  scope: BackofficeContextScope,
  event: SandboxLifecycleEvent,
): AutomationEvent {
  return {
    id: event.id,
    scope,
    source: "sandbox",
    eventType: `instance.${event.type}`,
    occurredAt: new Date().toISOString(),
    payload: {
      sandboxId: event.sandboxId,
      provider: event.provider,
      status: event.status,
      ...(event.type === "failed" ? { reason: event.reason, error: event.error } : {}),
      ...(event.type === "stopped" && event.reason ? { reason: event.reason } : {}),
    },
    actors: {
      initiator: AUTOMATION_SYSTEM_INITIATOR,
      principal: null,
      delegation: [],
    },
    subject: {
      ...(scope.kind === "org" || scope.kind === "project" ? { orgId: scope.orgId } : {}),
      ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
      sandboxId: event.sandboxId,
    },
  };
}

async function createPhysicalSandboxId(managerId: string, sandboxId: string): Promise<string> {
  const identity = new TextEncoder().encode(`${managerId}\0${sandboxId}`);
  const digest = await crypto.subtle.digest("SHA-256", identity);
  const hexadecimalDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  // Cloudflare sandbox IDs accept at most 63 characters; retaining 252 digest bits keeps
  // manager-scoped identities collision-resistant without constraining logical sandbox IDs.
  return hexadecimalDigest.slice(0, 63);
}

export class InMemorySandboxManagerObject extends RpcTarget implements SandboxManagerObject {
  readonly #host: FragmentDurableObjectHost<void, ReturnType<typeof createSandboxManagerRuntime>>;
  readonly #sandboxProviders: Record<string, SandboxRuntimeProvider>;
  #runtime: ReturnType<typeof createSandboxManagerRuntime> | null = null;

  constructor({
    state,
    env,
    runtime,
  }: {
    state: BackofficeObjectState;
    env: CloudflareEnv;
    runtime: BackofficeRuntimeServices;
  }) {
    super();
    const runtimeServices = runtime;
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "SANDBOX_MANAGER");
    this.#sandboxProviders = {
      [CLOUDFLARE_SANDBOX_PROVIDER]: createCloudflareSandboxProvider({
        sandboxNamespace: env.SANDBOX,
        sdk: {
          async getSandbox(namespace, id, options) {
            const { getSandbox } = await import("@cloudflare/sandbox");
            return getSandbox(
              namespace,
              await createPhysicalSandboxId(state.id.toString(), id),
              options,
            );
          },
        },
      }),
    };
    this.#host = createFragmentDurableObjectHost({
      name: "SandboxManager",
      state,
      env,
      createRuntime: () => {
        const runtime = createSandboxManagerRuntime(
          {
            adapters: runtimeServices.adapters,
            transactionInstrumentation: cloudflareDatabaseTransactionInstrumentation,
          },
          {
            sandboxProviders: this.#sandboxProviders,
            deliverLifecycleEvent: async (event) => {
              await runtimeServices.objects.automations
                .for(scope)
                .commands.triggerIngestEvent(buildSandboxAutomationEvent(scope, event));
            },
          },
        );
        return runtime;
      },
      getMigrationFragments: (runtime) => [
        runtime.workflowsFragment,
        runtime.sandboxManagerFragment,
      ],
      hostRuntime: (runtime, { hostFragment }) => ({
        ...runtime,
        workflowsFragment: hostFragment(runtime.workflowsFragment),
        sandboxManagerFragment: hostFragment(runtime.sandboxManagerFragment),
      }),
      mounts: [
        { id: "sandbox-manager", target: (runtime) => runtime.sandboxManagerFragment },
        { id: "workflows", target: (runtime) => runtime.workflowsFragment },
      ],
      durableHooksInstrumentation: cloudflareDurableHooksInstrumentation,
      operations: runtimeServices.fragmentHostOperations ?? undefined,
      onProcessError: (error) => {
        console.error("Sandbox manager hook processor error", error);
      },
    });
    void state.blockConcurrencyWhile(async () => {
      this.#runtime = await this.#host.initialize(undefined);
    });
  }

  #fragment() {
    if (!this.#runtime) {
      throw new Error("Sandbox manager is unavailable.");
    }
    return this.#runtime.sandboxManagerFragment;
  }

  async listSandboxInstances(input?: { provider?: SandboxProvider; limit?: number }) {
    const fragment = this.#fragment();
    return await fragment.callServices(() => fragment.services.listSandboxInstances(input));
  }

  async getSandboxInstance(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    const fragment = this.#fragment();
    return await fragment.callServices(() => fragment.services.getSandboxInstance(input));
  }

  async requestSandboxInstance(input: SandboxInstanceRequestInput): Promise<SandboxInstanceRecord> {
    const fragment = this.#fragment();
    return await fragment.callServices(() => fragment.services.requestSandboxInstance(input));
  }

  async requestSandboxInstanceStop(input: { id: string }): Promise<SandboxInstanceRecord | null> {
    const fragment = this.#fragment();
    const instance = await fragment.callServices(() => fragment.services.getSandboxInstance(input));
    if (!instance?.workflowInstanceId) {
      return instance;
    }
    const workflowInstanceId = instance.workflowInstanceId;
    return await fragment.callServices(() =>
      fragment.services.requestSandboxInstanceStop({ id: input.id, workflowInstanceId }),
    );
  }

  async executeSandboxCommand(input: {
    sandboxId: string;
    command: string;
    timeoutMs?: number;
  }): Promise<SandboxCommandResult> {
    const fragment = this.#fragment();
    const instance = await fragment.callServices(() =>
      fragment.services.getSandboxInstance({ id: input.sandboxId }),
    );
    if (instance?.status !== "running") {
      return {
        ok: false,
        reason: "sandbox_unavailable",
        message: `Sandbox "${input.sandboxId}" is unavailable.`,
        retryable: true,
      };
    }

    const provider = this.#sandboxProviders[instance.provider];
    if (!provider) {
      return {
        ok: false,
        reason: "internal_error",
        message: `No sandbox provider configured for '${instance.provider}'.`,
        retryable: false,
      };
    }

    const handle = await provider.getHandle(input.sandboxId);
    return await handle.executeCommand(input.command, { timeoutMs: input.timeoutMs });
  }

  async alarm() {
    await this.#host.alarm();
  }
  async fetch(request: Request) {
    if (!this.#runtime) {
      throw new Error("Sandbox manager is unavailable.");
    }
    return await this.#host.fetch(this.#runtime, request);
  }
}

export class SandboxManager extends DurableObject<CloudflareEnv> implements SandboxManagerObject {
  readonly #object: InMemorySandboxManagerObject;
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemorySandboxManagerObject({
      state,
      env,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }
  async listSandboxInstances(input?: { provider?: SandboxProvider; limit?: number }) {
    return await this.#object.listSandboxInstances(input);
  }
  async getSandboxInstance(input: { id: string }) {
    return await this.#object.getSandboxInstance(input);
  }
  async requestSandboxInstance(input: SandboxInstanceRequestInput) {
    return await this.#object.requestSandboxInstance(input);
  }
  async requestSandboxInstanceStop(input: { id: string }) {
    return await this.#object.requestSandboxInstanceStop(input);
  }
  async executeSandboxCommand(input: { sandboxId: string; command: string; timeoutMs?: number }) {
    return await this.#object.executeSandboxCommand(input);
  }
  async alarm() {
    await this.#object.alarm();
  }
  async fetch(request: Request) {
    return await this.#object.fetch(request);
  }
}
