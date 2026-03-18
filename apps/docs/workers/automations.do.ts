import { DurableObject } from "cloudflare:workers";

import { migrate } from "@fragno-dev/db";

import type { AutomationEvent, AutomationIngestResult } from "@/fragno/automation";
import { builtinAutomationBindings, builtinAutomationScripts } from "@/fragno/automation/builtins";
import {
  buildNotConfiguredResponse,
  createAutomationsDispatcher,
  createAutomationsRuntime,
  type AutomationsRuntime,
} from "@/fragno/automations";
import {
  loadDurableHookQueue,
  type DurableHookQueueOptions,
  type DurableHookQueueResponse,
} from "@/fragno/durable-hooks";
import { createPiRouteBashRuntime } from "@/fragno/pi";
import {
  PI_MODEL_CATALOG,
  createPiAgentName,
  resolvePiHarnesses,
  type PiConfigState,
} from "@/fragno/pi-shared";
import { createTelegramSourceAdapter } from "@/fragno/telegram";

const resolveDefaultPiAgent = (configState: PiConfigState) => {
  if (!configState.configured || !configState.config) {
    return undefined;
  }

  const harness = resolvePiHarnesses(configState.config.harnesses)[0];
  const model = PI_MODEL_CATALOG.find((option) => {
    return Boolean(configState.config?.apiKeys?.[option.provider]);
  });

  if (!harness || !model) {
    return undefined;
  }

  return createPiAgentName({
    harnessId: harness.id,
    provider: model.provider,
    model: model.name,
  });
};

export class Automations extends DurableObject<CloudflareEnv> {
  #env: CloudflareEnv;
  #state: DurableObjectState;
  #runtime: AutomationsRuntime | null = null;
  private initPromise: Promise<void>;
  private readonly automationRoutePrefix = "/api/automations/bindings";

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#env = env;
    this.#state = state;
    this.initPromise = this.#state.blockConcurrencyWhile(async () => {
      this.#runtime = createAutomationsRuntime(state, {
        env: this.#env,
        sourceAdapters: {
          telegram: createTelegramSourceAdapter({
            reply: this.#replyToTelegram.bind(this),
          }),
        },
        createPiAutomationContext: this.#createPiAutomationContext.bind(this),
        builtinScripts: builtinAutomationScripts,
        builtinBindings: builtinAutomationBindings,
      });
      await migrate(this.#runtime.workflowsFragment);
      await migrate(this.#runtime.automationFragment);
      this.#runtime.dispatcher = createAutomationsDispatcher(
        this.#runtime.workflowsFragment,
        this.#runtime.automationFragment,
        state,
        env,
      );
    });
  }

  async #ensureRuntime() {
    await this.initPromise;
  }

  async #notifyDispatcher() {
    if (!this.#runtime?.dispatcher?.notify) {
      return;
    }

    await this.#runtime.dispatcher.notify({
      source: "request",
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }

  async #replyToTelegram(input: { event: AutomationEvent; externalActorId: string; text: string }) {
    const orgId = input.event.orgId?.trim();
    if (!orgId) {
      throw new Error("Telegram replies require an organisation id");
    }

    const telegramDo = this.#env.TELEGRAM.get(this.#env.TELEGRAM.idFromName(orgId));
    await telegramDo.sendAutomationReply({
      chatId: input.externalActorId,
      text: input.text,
    });
  }

  async #createPiAutomationContext(input: { event: AutomationEvent; idempotencyKey: string }) {
    const orgId = input.event.orgId?.trim();
    if (!orgId) {
      return undefined;
    }

    const piDo = this.#env.PI.get(this.#env.PI.idFromName(orgId));
    const configState = await piDo.getAdminConfig();
    const defaultAgent = resolveDefaultPiAgent(configState);
    if (!defaultAgent) {
      return undefined;
    }

    return {
      runtime: createPiRouteBashRuntime({
        env: this.#env,
        orgId,
      }),
      bashEnv: {
        AUTOMATION_PI_DEFAULT_AGENT: defaultAgent,
      },
    };
  }

  async triggerIngestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    await this.#ensureRuntime();

    if (!this.#runtime?.automationFragment) {
      throw new Error("Automations runtime is not ready.");
    }

    const result = await this.#runtime.automationFragment.callServices(() =>
      this.#runtime!.automationFragment.services.ingestEvent(event),
    );

    await this.#notifyDispatcher();
    return result;
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
    return await this.triggerIngestEvent(event);
  }

  async alarm() {
    await this.#ensureRuntime();
    await this.#runtime?.dispatcher?.alarm?.();
  }

  async getHookQueue(
    options?: DurableHookQueueOptions & {
      fragment?: "workflows" | "automation";
    },
  ): Promise<DurableHookQueueResponse> {
    await this.#ensureRuntime();

    if (!this.#runtime?.workflowsFragment || !this.#runtime?.automationFragment) {
      return {
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      };
    }

    const targetFragment =
      options?.fragment === "workflows"
        ? this.#runtime.workflowsFragment
        : this.#runtime.automationFragment;
    return loadDurableHookQueue(targetFragment, options);
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ensureRuntime();

    if (!this.#runtime?.workflowsFragment || !this.#runtime?.automationFragment) {
      return buildNotConfiguredResponse();
    }

    const url = new URL(request.url);
    const targetFragment = url.pathname.startsWith(this.automationRoutePrefix)
      ? this.#runtime.automationFragment
      : this.#runtime.workflowsFragment;

    return targetFragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
