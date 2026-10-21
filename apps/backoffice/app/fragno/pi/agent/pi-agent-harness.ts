import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  Harness,
  type Extension,
  type HarnessSettings,
  type Storage,
} from "@earendil-works/pi-durable";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BillingEventInput } from "@/fragno/billing/contracts";
import { usageBillingForScope, type UsageBilling } from "@/fragno/billing/usage-billing";
import { createBackofficeExtension } from "@/fragno/pi/extensions/backoffice/backoffice-extension";
import {
  calculatePiDurableBillingRetryDelayMs,
  createPiBilling,
  type PiBilling,
} from "@/fragno/pi/extensions/billing/billing-extension";

import { createAuthorizedPiModels } from "./authorized-models";
import {
  createBackofficeAgentContext,
  type BackofficeAgentContext,
} from "./backoffice-agent-context";
import { startReportingPiAgentTurns } from "./pi-agent-turn-events";
import { readActivePiAgentTurn } from "./pi-agent-turns";
import { createPiModels, PI_THINKING_LEVEL } from "./pi-models";

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
  /** Reports every settled turn not yet reported to Automations and the agent's manager. */
  reportSettledTurns: (context: Context) => Promise<void>;
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

/** Rebuilds an agent's registry and opens its root conversation; authority comes from its turns. */
export async function openPiAgentHarness(input: {
  config: PiAgentConfig;
  /** Null for agents provisioned since owner attribution, which have no legacy deliveries. */
  legacyBillingScope: BackofficeContextScope | null;
  runtime: BackofficeRuntimeServices;
  dependencies: PiAgentDependencies;
  openStorage: () => Promise<Storage>;
  nowEpochMs: () => number;
}): Promise<OpenPiAgent> {
  const { config, runtime, dependencies } = input;
  function report(error: unknown) {
    dependencies.report(error, config);
  }
  let opened: { harness: Harness; storage: Storage } | null = null;
  const agent = createBackofficeAgentContext({
    config,
    runtime,
    readActiveTurn: async (context) =>
      opened ? await readActivePiAgentTurn(opened.harness, opened.storage, context) : null,
  });
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

  const registry = createRegistry();
  for (const extension of [
    ...dependencies.extensions(config, agent),
    createBackofficeExtension(agent),
    billing.extension,
  ]) {
    registry.install(extension);
  }

  const storage = await input.openStorage();
  const harness = await Harness.open(
    storage,
    {
      // Pi isolates failures in prompt sections and hooks, so only the model boundary can fail closed.
      models: createAuthorizedPiModels(dependencies.models, async () => {
        await (await agent.activeTurn(BACKGROUND_CONTEXT)).authorize();
      }),
      registry,
      settings: {
        ...dependencies.settings,
        stream: { maxRetries: 3, ...dependencies.settings.stream },
      },
      onReport: report,
    },
    BACKGROUND_CONTEXT,
  );
  opened = { harness, storage };
  const reportSettledTurns = startReportingPiAgentTurns({
    config,
    agent,
    harness,
    storage,
    automations: runtime.config.bindings.automations
      ? runtime.objects.automations.for(config.scope).commands
      : null,
    manager: runtime.objects.piManager.for(config.scope).commands,
    nowEpochMs: input.nowEpochMs,
    report,
  });
  try {
    await harness.root(BACKGROUND_CONTEXT, { agent: { thinkingLevel: PI_THINKING_LEVEL } });
  } catch (cause) {
    await harness.close(BACKGROUND_CONTEXT);
    throw cause;
  }
  return { harness, storage, billing, reportSettledTurns };
}
