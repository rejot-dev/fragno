import { DurableObject } from "cloudflare:workers";

import type { SandboxInstanceStatus, SandboxInstanceSummary } from "@/sandbox/contracts";

const SANDBOX_ID_KEY_PREFIX = "sandbox-id:";
const TRACKED_SANDBOX_VALUE = 1;

function sandboxIdStorageKey(id: string) {
  return `${SANDBOX_ID_KEY_PREFIX}${id}`;
}

function parseSandboxId(storageKey: string) {
  return storageKey.slice(SANDBOX_ID_KEY_PREFIX.length);
}

export class SandboxRegistry extends DurableObject<CloudflareEnv> {
  #state: DurableObjectState;
  #env: CloudflareEnv;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
    this.#env = env;
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
    const sandbox = this.#env.SANDBOX.get(this.#env.SANDBOX.idFromName(id));

    try {
      const runtimeStatus = await sandbox.getRuntimeStatus();
      return runtimeStatus.status;
    } catch (error) {
      console.warn("Failed to get live sandbox runtime status", { sandboxId: id, error });
      return "error";
    }
  }
}
