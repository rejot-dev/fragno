import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  DEFAULT_COMPACTION_POLICY,
  Harness,
  ROOT_CONVERSATION_ID,
  type CompactionPolicy,
  type CompactionSettings,
  type Extension,
  type HarnessSettings,
  type ModelRef,
  type Storage,
  type ToolRegistration,
  type Wake,
} from "@earendil-works/pi-durable";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BillingEventInput } from "@/fragno/billing/contracts";
import { usageBillingForScope, type UsageBilling } from "@/fragno/billing/usage-billing";
import { createAwaitSubagentsTool } from "@/fragno/pi/extensions/backoffice/await-subagents-tool";
import { createBackofficeExtension } from "@/fragno/pi/extensions/backoffice/backoffice-extension";
import {
  calculatePiDurableBillingRetryDelayMs,
  createPiBilling,
  type PiBilling,
} from "@/fragno/pi/extensions/billing/billing-extension";

import { PI_DEFINED_AGENT_THINKING_LEVEL } from "./agent-definitions";
import { createAuthorizedPiModels } from "./authorized-models";
import {
  createBackofficeAgentContext,
  type BackofficeAgentContext,
} from "./backoffice-agent-context";
import { estimatePiContextTokens } from "./context-usage";
import { piConversationOfSession } from "./pi-agent-subagents";
import { startReportingPiAgentTurns } from "./pi-agent-turn-events";
import { readActivePiAgentTurn } from "./pi-agent-turns";
import { createPiModels } from "./pi-models";

/** What a runtime supplies to every agent it hosts; scenarios substitute scripted models. */
export type PiAgentDependencies = {
  models: Models;
  /** Installed before Backoffice's own extensions, whose same-name tools therefore win. */
  extensions: (config: PiAgentConfig, agent: BackofficeAgentContext) => readonly Extension[];
  settings: HarnessSettings;
  report: (error: unknown, config: PiAgentConfig | null) => void;
};

export type OpenPiAgent = {
  harness: Harness;
  storage: Storage;
  billing: PiBilling;
  /**
   * The `awaitSubagents` tool, which subagents run without, so none holds a slot waiting for
   * subagents that need one.
   */
  awaitSubagentsTool: ToolRegistration;
  /** Reports the turns started and settled since the last report to Automations and the manager. */
  reportTurns: (context: Context) => Promise<void>;
};

/** Production agents use credential-backed providers and Pi's default run policy. */
export function createPiAgentDependencies(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">,
): PiAgentDependencies {
  return {
    models: createPiModels(env),
    extensions: () => [],
    settings: {},
    report: (error, config) => {
      // Workers captured bare Error objects as stack-only logs, hiding the callback path and cause.
      // Project diagnostic fields explicitly; never serialize arbitrary error/provider payloads.
      const errors: { name: string; message: string; stack: string | null }[] = [];
      const seen = new Set<unknown>();
      let current: unknown = error;
      do {
        seen.add(current);
        errors.push(
          current instanceof Error
            ? { name: current.name, message: current.message, stack: current.stack ?? null }
            : { name: "NonError", message: String(current), stack: null },
        );
        current = current instanceof Error ? current.cause : undefined;
      } while (current !== undefined && !seen.has(current) && errors.length < 16);
      console.error({
        event: "pi.agent.error",
        agent: config,
        message: errors[0].message,
        errors,
        causeChainTruncated: current !== undefined,
      });
    },
  };
}

/** The compaction policy Pi applies to `model`: its override over the harness-wide one, by field. */
function piCompactionPolicy(settings: HarnessSettings, model: ModelRef): CompactionPolicy {
  const { modelOverrides, ...harnessWide } = settings.compaction ?? {};
  return {
    ...DEFAULT_COMPACTION_POLICY,
    ...harnessWide,
    ...modelOverrides?.[`${model.provider}/${model.modelId}`],
  };
}

/**
 * Pi's compaction settings without its background compaction, for every model. The queue compacts
 * between turns instead (see `isPiCompactionDue`); a turn that outgrows the window on its own still
 * compacts at Pi's blocking threshold, or on overflow.
 */
function withoutBackgroundCompaction(settings: HarnessSettings): CompactionSettings {
  const { modelOverrides, ...harnessWide } = settings.compaction ?? {};
  return {
    ...harnessWide,
    backgroundTokens: 0,
    ...(modelOverrides && {
      modelOverrides: Object.fromEntries(
        Object.entries(modelOverrides).map(([model, policy]) => [
          model,
          { ...policy, backgroundTokens: 0 },
        ]),
      ),
    }),
  };
}

/**
 * Whether the root's context passed the threshold where Pi would start background compaction,
 * `backgroundTokens` below its blocking one. Backoffice compacts there once a turn ends instead,
 * so compaction never runs beside a turn and the next turn waits for it.
 */
async function isPiCompactionDue(
  harness: Harness,
  models: Models,
  settings: HarnessSettings,
  context: Context,
): Promise<boolean> {
  const root = await harness.root(context);
  const { model } = await root.agent(context);
  if (!model) {
    return false;
  }
  const policy = piCompactionPolicy(settings, model);
  const contextWindow = models.getModel(model.provider, model.modelId)?.contextWindow;
  if (!policy.enabled || policy.backgroundTokens === 0 || !contextWindow) {
    return false;
  }
  const { entries } = await root.context(context);
  return (
    estimatePiContextTokens(entries) >
    contextWindow - policy.reserveTokens - policy.backgroundTokens
  );
}

/** Rebuilds an agent's registry and opens its root conversation; authority comes from its turns. */
export async function openPiAgentHarness(input: {
  config: PiAgentConfig;
  /** Null for agents provisioned since owner attribution, which have no legacy deliveries. */
  legacyBillingScope: BackofficeContextScope | null;
  runtime: BackofficeRuntimeServices;
  dependencies: PiAgentDependencies;
  openStorage: () => Promise<Storage>;
  nowEpochMs: () => number;
  /** Told whenever the agent's next wakeup changes; Pi keeps no timers of its own for sleeps. */
  onWake: (wake: Wake) => void;
}): Promise<OpenPiAgent> {
  const { config, runtime, dependencies } = input;
  function report(error: unknown) {
    dependencies.report(error, config);
  }
  let opened: { harness: Harness; storage: Storage } | null = null;
  const agent = createBackofficeAgentContext({
    config,
    runtime,
    readActiveTurn: async (conversationId, context) =>
      opened
        ? await readActivePiAgentTurn(opened.harness, opened.storage, conversationId, context)
        : null,
  });
  // A deferred fetch names no session. It continues a request checked when it started, and is
  // checked again as the root's, as before subagents.
  async function requestConversation(sessionId: string | undefined) {
    if (sessionId === undefined) {
      return ROOT_CONVERSATION_ID;
    }
    const conversationId = opened
      ? await piConversationOfSession(opened.harness, sessionId, BACKGROUND_CONTEXT)
      : null;
    if (conversationId === null) {
      throw new Error(
        "PI_AGENT_TURN_UNAVAILABLE: no running conversation made this model request.",
      );
    }
    return conversationId;
  }
  const usageBilling = usageBillingForScope(runtime, config.scope);
  const legacyBilling =
    input.legacyBillingScope === null
      ? null
      : usageBillingForScope(runtime, input.legacyBillingScope);
  async function record(billing: UsageBilling, event: BillingEventInput) {
    return billing.kind === "system"
      ? { eventId: event.id, accepted: false }
      : await billing.recordEvent(event, { propagationContext: null });
  }
  const billing = createPiBilling({
    config,
    recordEvent: (event) => record(usageBilling, event),
    recordLegacyEvent: async (event) => {
      if (legacyBilling === null) {
        throw new Error(
          "PI_BILLING_LEGACY_DESTINATION_MISSING: only agents provisioned before owner attribution have legacy deliveries.",
        );
      }
      return await record(legacyBilling, event);
    },
    retryDelayMs: calculatePiDurableBillingRetryDelayMs,
  });

  const awaitSubagentsTool = createAwaitSubagentsTool(
    async (conversationId, requestId, context) => {
      if (!opened) {
        throw new Error("The Pi agent is not open.");
      }
      const record = await opened.storage.submissionByRequest(conversationId, requestId, context);
      const submission = record && (await opened.harness.submission(record.id, context));
      if (!submission) {
        throw new Error(`Subagent ${requestId} has no submission.`);
      }
      return await submission.wait(context);
    },
  );
  const registry = createRegistry();
  for (const extension of [
    ...dependencies.extensions(config, agent),
    createBackofficeExtension(agent, awaitSubagentsTool),
    billing.extension,
  ]) {
    registry.install(extension);
  }

  const storage = await input.openStorage();
  const harness = await Harness.open(
    storage,
    {
      // Pi isolates failures in prompt sections and hooks, so only the model boundary can fail closed.
      models: createAuthorizedPiModels(dependencies.models, async (sessionId) => {
        const conversationId = await requestConversation(sessionId);
        await (await agent.activeTurn(conversationId, BACKGROUND_CONTEXT)).authorize();
      }),
      registry,
      settings: {
        ...dependencies.settings,
        stream: { maxRetries: 3, ...dependencies.settings.stream },
        compaction: withoutBackgroundCompaction(dependencies.settings),
      },
      onReport: report,
      // Sleep deadlines and the object's alarms must read one clock.
      now: input.nowEpochMs,
      onWake: input.onWake,
    },
    BACKGROUND_CONTEXT,
  );
  opened = { harness, storage };
  const reportTurns = startReportingPiAgentTurns({
    config,
    agent,
    harness,
    storage,
    automations: runtime.config.bindings.automations
      ? runtime.objects.automations.for(config.scope).commands
      : null,
    manager: runtime.objects.piManager.for(config.scope).commands,
    compactionDue: (context) =>
      isPiCompactionDue(harness, dependencies.models, dependencies.settings, context),
    nowEpochMs: input.nowEpochMs,
    report,
  });
  try {
    await harness.root(BACKGROUND_CONTEXT, {
      agent: { thinkingLevel: PI_DEFINED_AGENT_THINKING_LEVEL },
    });
  } catch (cause) {
    await harness.close(BACKGROUND_CONTEXT);
    throw cause;
  }
  return { harness, storage, billing, awaitSubagentsTool, reportTurns };
}
