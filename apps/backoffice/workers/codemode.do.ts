import type { CodemodeHost } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { DurableObject } from "cloudflare:workers";

import type { CodemodeCommands } from "@/backoffice-runtime/object-registry";
import type {
  CodemodeRunActivation,
  CodemodeRunContext,
  CodemodeExecution,
  CodemodeRunDetail,
  CodemodeRunPageInput,
  CodemodeRunPage,
} from "@/fragno/codemode/codemode-fragment";
import type { CodemodeRunLease } from "@/fragno/codemode/codemode-object-execute";
import type { DurableHookQueueOptions } from "@/fragno/durable-hooks";

import type { CodemodeObject } from "./codemode-object";

export class Codemode extends DurableObject<CloudflareEnv> implements CodemodeCommands {
  #object!: CodemodeObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { CodemodeObject } = await import("./codemode-object");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      this.#object = new CodemodeObject(createCloudflareBackofficeObjectContext(state, env));
    });
  }

  execute<TActivation extends CodemodeRunActivation>(
    activation: TActivation,
    context: CodemodeRunContext,
    host: CodemodeHost,
    lease: CodemodeRunLease,
    redactedResults: readonly string[],
  ): Promise<CodemodeExecution<TActivation>> {
    return this.#object.execute(activation, context, host, lease, redactedResults);
  }

  getRun(runId: string): Promise<CodemodeRunDetail | null> {
    return this.#object.getRun(runId);
  }

  listRuns(input: CodemodeRunPageInput): Promise<CodemodeRunPage> {
    return this.#object.listRuns(input);
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }

  getDurableHookQueue(options?: DurableHookQueueOptions) {
    return this.#object.getDurableHookQueue(options);
  }

  getDurableHook(hookId: string) {
    return this.#object.getDurableHook(hookId);
  }

  async wakeDurableHooks() {
    await this.#object.wakeDurableHooks();
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
