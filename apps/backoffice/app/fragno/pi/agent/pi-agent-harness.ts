import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

import {
  createRegistry,
  Harness,
  type Extension,
  type HarnessSettings,
  type Storage,
} from "@earendil-works/pi-durable";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createBackofficeExtension } from "@/fragno/pi/extensions/backoffice/backoffice-extension";
import {
  calculatePiDurableBillingRetryDelayMs,
  createPiBilling,
  type PiBilling,
} from "@/fragno/pi/extensions/billing/billing-extension";
import { loadWorkspaceExtensions } from "@/fragno/pi/extensions/workspace/workspace-extensions";

import { createAuthorizedPiModels } from "./authorized-models";
import { createBackofficeAgentContext } from "./backoffice-agent-context";
import { createPiModels, PI_THINKING_LEVEL } from "./pi-models";

/** What a runtime supplies to every agent it hosts; scenarios substitute scripted models. */
export type PiAgentDependencies = {
  models: Models;
  /** Installed before Backoffice's own extensions, whose same-name tools therefore win. */
  extensions: (config: PiAgentConfig) => readonly Extension[];
  settings: HarnessSettings;
  report: (error: unknown) => void;
};

export type OpenPiAgent = {
  harness: Harness;
  storage: Storage;
  billing: PiBilling | null;
};

/** Production agents use credential-backed providers and Pi's default run policy. */
export function createPiAgentDependencies(
  env: Pick<BackofficeRuntimeEnv, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY">,
): PiAgentDependencies {
  return {
    models: createPiModels(env),
    extensions: () => [],
    settings: {},
    report: (error) => {
      console.error(error);
    },
  };
}

/** Rebuilds an agent's registry from persisted provenance and opens its root conversation. */
export async function openPiAgentHarness(input: {
  config: PiAgentConfig;
  runtime: BackofficeRuntimeServices;
  dependencies: PiAgentDependencies;
  openStorage: () => Promise<Storage>;
}): Promise<OpenPiAgent> {
  const { config, runtime, dependencies } = input;
  const agent = createBackofficeAgentContext({ config, runtime });
  const billingOrganizationId = config.billingOrganizationId;
  // Usage remains in pi.usage and is backfilled when an optional Billing binding is later configured.
  const billing =
    billingOrganizationId && runtime.config.bindings.billing
      ? createPiBilling({
          config,
          recordEvent: async (event) =>
            await runtime.objects.billing.forOrg(billingOrganizationId).commands.recordEvent(event),
          retryDelayMs: calculatePiDurableBillingRetryDelayMs,
        })
      : null;

  const registry = createRegistry();
  for (const extension of [
    ...dependencies.extensions(config),
    createBackofficeExtension(agent),
    ...(billing ? [billing.extension] : []),
  ]) {
    registry.install(extension);
  }
  for (const extension of await loadWorkspaceExtensions({
    agent,
    registry: registry.snapshot(),
    report: dependencies.report,
  })) {
    registry.install(extension);
  }

  const storage = await input.openStorage();
  const harness = await Harness.open(
    storage,
    {
      // Pi isolates failures in prompt sections and hooks, so only the model boundary can fail closed.
      models: createAuthorizedPiModels(dependencies.models, agent.authorize),
      registry,
      settings: {
        ...dependencies.settings,
        stream: { maxRetries: 3, ...dependencies.settings.stream },
      },
      onReport: dependencies.report,
    },
    BACKGROUND_CONTEXT,
  );
  try {
    await harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: config.model,
        instructions: config.instructions,
        thinkingLevel: PI_THINKING_LEVEL,
      },
    });
  } catch (cause) {
    await harness.close(BACKGROUND_CONTEXT);
    throw cause;
  }
  return { harness, storage, billing };
}
