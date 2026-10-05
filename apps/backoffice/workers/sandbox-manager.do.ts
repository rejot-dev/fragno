import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { DurableObject, RpcTarget } from "cloudflare:workers";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type SandboxManagerObject,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { AUTOMATION_SYSTEM_INITIATOR } from "@/fragno/automation/actors";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import type {
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxLifecycleEvent,
  SandboxProvider,
} from "@/fragno/sandbox-manager/contracts";
import { createSandboxManagerRuntime } from "@/fragno/sandbox-manager/sandbox-manager";
import { createCloudflareSandboxPhysicalId } from "@/sandbox/cloudflare-sandbox-id";
import { createCloudflareSandboxProvider } from "@/sandbox/cloudflare-sandbox-provider";
import { CLOUDFLARE_SANDBOX_PROVIDER } from "@/sandbox/contracts";
import type { SandboxCommandResult, SandboxRuntimeProviders } from "@/sandbox/contracts";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";

function buildSandboxAutomationEvent(
  scope: BackofficeContextScope,
  event: SandboxLifecycleEvent,
): AutomationEvent {
  return {
    id: event.id,
    scopeRestriction: null,
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

export class InMemorySandboxManagerObject extends RpcTarget implements SandboxManagerObject {
  readonly #host: FragmentDurableObjectHost<void, ReturnType<typeof createSandboxManagerRuntime>>;
  readonly #sandboxProviders: SandboxRuntimeProviders;
  #runtime: ReturnType<typeof createSandboxManagerRuntime> | null = null;

  constructor({
    state,
    runtime,
    implementation,
    sandboxProviders,
  }: {
    state: BackofficeObjectState;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    sandboxProviders: SandboxRuntimeProviders;
  }) {
    super();
    const runtimeServices = runtime;
    const scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "SANDBOX_MANAGER");
    this.#sandboxProviders = sandboxProviders;
    this.#host = implementation.createFragmentHost({
      name: "SandboxManager",
      createRuntime: () => {
        const runtime = createSandboxManagerRuntime(implementation.fragmentDatabase, {
          sandboxProviders: this.#sandboxProviders,
          deliverLifecycleEvent: async (event) => {
            await runtimeServices.objects.automations
              .for(scope)
              .commands.triggerIngestEvent(buildSandboxAutomationEvent(scope, event));
          },
        });
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
        code: "sandbox_unavailable",
        reason: "sandbox_unavailable",
        message: `Sandbox "${input.sandboxId}" is unavailable.`,
        retryable: true,
      };
    }

    const provider = this.#sandboxProviders[instance.provider];
    if (!provider) {
      return {
        ok: false,
        code: "provider_not_configured",
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
    const managerId = state.id.toString();
    this.#object = new InMemorySandboxManagerObject({
      ...createCloudflareBackofficeObjectContext(state, env),
      sandboxProviders: {
        [CLOUDFLARE_SANDBOX_PROVIDER]: createCloudflareSandboxProvider({
          sandboxNamespace: env.SANDBOX,
          sdk: {
            async getSandbox(namespace, id, options) {
              const { getSandbox } = await import("@cloudflare/sandbox");
              return getSandbox(
                namespace,
                await createCloudflareSandboxPhysicalId(managerId, id),
                options,
              );
            },
          },
        }),
      },
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
