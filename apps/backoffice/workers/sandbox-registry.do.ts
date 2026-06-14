import { DurableObject } from "cloudflare:workers";

import type { SandboxRegistryObject } from "@/backoffice-runtime/object-registry";
import {
  createCloudflareDurableObjectRuntimeServices,
  type BackofficeRuntimeServices,
} from "@/backoffice-runtime/runtime-services";
import type { SandboxInstanceStatus, SandboxInstanceSummary } from "@/sandbox/contracts";

const SANDBOX_ID_KEY_PREFIX = "sandbox-id:";
const TRACKED_SANDBOX_VALUE = 1;

function sandboxIdStorageKey(id: string) {
  return `${SANDBOX_ID_KEY_PREFIX}${id}`;
}

function parseSandboxId(storageKey: string) {
  return storageKey.slice(SANDBOX_ID_KEY_PREFIX.length);
}

type SandboxRegistryObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};

type SandboxRegistryObjectState = {
  storage: SandboxRegistryObjectStorage;
};

export class InMemorySandboxRegistryObject implements SandboxRegistryObject {
  #state: SandboxRegistryObjectState;
  #runtime: BackofficeRuntimeServices;

  constructor({
    state,
    runtime,
  }: {
    state: SandboxRegistryObjectState;
    runtime: BackofficeRuntimeServices;
  }) {
    this.#state = state;
    this.#runtime = runtime;
  }

  async getInstances(): Promise<SandboxInstanceSummary[]> {
    const sandboxIds = await this.#listTrackedSandboxIds();
    const instances = await Promise.all(
      sandboxIds.map(async (id) => ({
        id,
        status: await this.#getLiveSandboxStatus(id),
      })),
    );

    return instances.sort((a, b) => a.id.localeCompare(b.id));
  }

  async listInstances(): Promise<SandboxInstanceSummary[]> {
    return this.getInstances();
  }

  async getInstance(id: string): Promise<SandboxInstanceSummary | null> {
    const tracked = await this.hasInstance(id);
    if (!tracked) {
      return null;
    }

    return {
      id,
      status: await this.#getLiveSandboxStatus(id),
    };
  }

  async hasInstance(id: string): Promise<boolean> {
    const value = await this.#state.storage.get<number>(sandboxIdStorageKey(id));
    return value === TRACKED_SANDBOX_VALUE;
  }

  async trackInstance(id: string): Promise<void> {
    await this.#state.storage.put(sandboxIdStorageKey(id), TRACKED_SANDBOX_VALUE);
  }

  async untrackInstance(id: string): Promise<void> {
    await this.#state.storage.delete(sandboxIdStorageKey(id));
  }

  async #listTrackedSandboxIds(): Promise<string[]> {
    const stored = await this.#state.storage.list<number>({
      prefix: SANDBOX_ID_KEY_PREFIX,
    });

    return Array.from(stored.keys())
      .map(parseSandboxId)
      .filter((id) => Boolean(id));
  }

  async #getLiveSandboxStatus(id: string): Promise<SandboxInstanceStatus> {
    const sandbox = this.#runtime.objects.sandbox.forName(id);

    try {
      const runtimeStatus = await sandbox.getRuntimeStatus();
      return runtimeStatus.status;
    } catch (error) {
      console.warn("Failed to get live sandbox runtime status", { sandboxId: id, error });
      return "error";
    }
  }
}

export class SandboxRegistry extends DurableObject<CloudflareEnv> implements SandboxRegistryObject {
  #object: InMemorySandboxRegistryObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemorySandboxRegistryObject({
      state,
      runtime: createCloudflareDurableObjectRuntimeServices(env, state),
    });
  }

  async getInstances(): Promise<SandboxInstanceSummary[]> {
    return await this.#object.getInstances();
  }

  async listInstances(): Promise<SandboxInstanceSummary[]> {
    return await this.#object.listInstances();
  }

  async getInstance(id: string): Promise<SandboxInstanceSummary | null> {
    return await this.#object.getInstance(id);
  }

  async hasInstance(id: string): Promise<boolean> {
    return await this.#object.hasInstance(id);
  }

  async trackInstance(id: string): Promise<void> {
    await this.#object.trackInstance(id);
  }

  async untrackInstance(id: string): Promise<void> {
    await this.#object.untrackInstance(id);
  }
}
