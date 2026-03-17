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
import { createTelegramSourceAdapter } from "@/fragno/telegram";

const AUTOMATIONS_PUBLIC_BASE_URL_KEY = "automations-public-base-url";

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
        sourceAdapters: {
          telegram: createTelegramSourceAdapter({
            reply: this.#replyToTelegram.bind(this),
          }),
        },
        createIdentityClaim: this.#createIdentityClaim.bind(this),
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

  async #resolveConfiguredPublicBaseUrl() {
    const envBaseUrl = this.#env.DOCS_PUBLIC_BASE_URL?.trim();
    if (envBaseUrl) {
      return envBaseUrl;
    }

    const stored = await this.#state.storage.get<string>(AUTOMATIONS_PUBLIC_BASE_URL_KEY);
    const remembered = stored?.trim();
    if (remembered) {
      return remembered;
    }

    return null;
  }

  async #rememberPublicBaseUrl(request: Request) {
    const origin = new URL(request.url).origin.trim();
    if (!origin) {
      return null;
    }

    await this.#state.storage.put(AUTOMATIONS_PUBLIC_BASE_URL_KEY, origin);
    return origin;
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

  async #createIdentityClaim(input: {
    orgId?: string;
    source: string;
    externalActorId: string;
    ttlMinutes?: number;
  }) {
    const normalizedOrgId = input.orgId?.trim();
    if (!normalizedOrgId) {
      throw new Error("identity.create-claim requires an organisation id");
    }

    const publicBaseUrl = await this.#resolveConfiguredPublicBaseUrl();
    if (!publicBaseUrl) {
      throw new Error(
        "No public base URL is configured for automations. Set DOCS_PUBLIC_BASE_URL or call the app over HTTP before issuing claims.",
      );
    }

    const otpDo = this.#env.OTP.get(this.#env.OTP.idFromName(normalizedOrgId));
    const issued = await otpDo.issueIdentityClaim({
      orgId: normalizedOrgId,
      linkSource: input.source,
      externalActorId: input.externalActorId,
      expiresInMinutes: input.ttlMinutes,
      publicBaseUrl,
    });

    return {
      url: issued.url,
      externalId: issued.externalId,
      code: issued.code,
      type: issued.type,
    };
  }

  async ingestEvent(event: AutomationEvent): Promise<AutomationIngestResult> {
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

    await this.#rememberPublicBaseUrl(request);

    const url = new URL(request.url);
    const targetFragment = url.pathname.startsWith(this.automationRoutePrefix)
      ? this.#runtime.automationFragment
      : this.#runtime.workflowsFragment;

    return targetFragment.handler(request, {
      waitUntil: this.#state.waitUntil.bind(this.#state),
    });
  }
}
