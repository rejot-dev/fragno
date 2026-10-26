import type { Sandbox } from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox.do";
import { DurableObject } from "cloudflare:workers";

import type { SandboxManagerCommands } from "@/backoffice-runtime/object-registry";
import type {
  SandboxProvider,
  SandboxInstanceRequestInput,
} from "@/fragno/sandbox-manager/contracts";

import type { SandboxManagerObject } from "./sandbox-manager-object";

export class SandboxManager extends DurableObject<CloudflareEnv> implements SandboxManagerCommands {
  #object!: SandboxManagerObject;
  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { SandboxManagerObject } = await import("./sandbox-manager-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      const { CLOUDFLARE_SANDBOX_PROVIDER } = await import("@/sandbox/contracts");
      const { createCloudflareSandboxPhysicalId } = await import("@/sandbox/cloudflare-sandbox-id");
      const { jurisdictionNamespace } =
        await import("@/backoffice-runtime/cloudflare-durable-object-factory");
      const { requireBackofficeContextScopeFromDurableObjectId } =
        await import("@/backoffice-runtime/object-registry");
      const { backofficeScopeJurisdiction } =
        await import("@fragno-dev/backoffice-api/v0/shared/scope");
      const managerId = state.id.toString();
      // Wrangler cannot type a binding to another Worker's class. Sandboxes are kept where their
      // manager's scope keeps its objects.
      const sandboxes = jurisdictionNamespace(
        env,
        env.SANDBOX as DurableObjectNamespace<Sandbox>,
        backofficeScopeJurisdiction(
          requireBackofficeContextScopeFromDurableObjectId(state.id, "SANDBOX_MANAGER"),
        ),
      );
      this.#object = new SandboxManagerObject({
        ...createCloudflareBackofficeObjectContext(state, env),
        sandboxProviders: {
          [CLOUDFLARE_SANDBOX_PROVIDER]: {
            provider: CLOUDFLARE_SANDBOX_PROVIDER,
            getHandle: async (id) =>
              sandboxes.getByName(await createCloudflareSandboxPhysicalId(managerId, id)),
          },
        },
      });
    });
  }
  async warm(): Promise<void> {
    await this.#object.warm();
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
