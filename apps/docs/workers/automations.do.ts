import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";

import {
  createAutomationsRuntime,
  createAutomationsDispatcher,
  type AutomationsRuntime,
  buildNotConfiguredResponse,
} from "@/fragno/automations";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";

export class Automations extends DurableObject<CloudflareEnv> {
  #state: DurableObjectState;
  #runtime: AutomationsRuntime | null = null;
  private initPromise: Promise<void>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#state = state;
    this.initPromise = this.#state.blockConcurrencyWhile(async () => {
      this.#runtime = createAutomationsRuntime(state);
      await migrate(this.#runtime.workflowsFragment);
      this.#runtime.dispatcher = createAutomationsDispatcher(
        this.#runtime.workflowsFragment,
        state,
        env,
      );
    });
  }

  async #ensureRuntime() {
    await this.initPromise;
  }

  async alarm() {
    await this.#ensureRuntime();
    await this.#runtime?.dispatcher?.alarm?.();
  }

  async getHookQueue(options?: DurableHookQueueOptions): Promise<DurableHookQueueResponse> {
    await this.#ensureRuntime();

    if (!this.#runtime?.workflowsFragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    return loadDurableHookQueue(this.#runtime.workflowsFragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ensureRuntime();

    if (!this.#runtime?.workflowsFragment) {
      return buildNotConfiguredResponse();
    }

    return this.#runtime.workflowsFragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
