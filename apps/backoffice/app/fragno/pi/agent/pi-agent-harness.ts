import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";

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
import { createBackofficeExtension } from "@/fragno/pi/extensions/backoffice/backoffice-extension";
import {
  calculatePiDurableBillingRetryDelayMs,
  createPiBilling,
  type PiBilling,
} from "@/fragno/pi/extensions/billing/billing-extension";
import {
  loadWorkspaceExtensions,
  type LoadedWorkspaceExtensions,
} from "@/fragno/pi/extensions/workspace/workspace-extensions";

import { createAuthorizedPiModels } from "./authorized-models";
import {
  createBackofficeAgentContext,
  type BackofficeAgentContext,
} from "./backoffice-agent-context";
import type { PiAgentTurn } from "./pi-agent-contract";
import { startReportingPiAgentTurns } from "./pi-agent-turn-events";
import { readActivePiAgentTurn } from "./pi-agent-turns";
import { createPiModels, PI_THINKING_LEVEL } from "./pi-models";

/** What a runtime supplies to every agent it hosts; scenarios substitute scripted models. */
export type PiAgentDependencies = {
  models: Models;
  /** Installed before Backoffice's own extensions, whose same-name tools therefore win. */
  extensions: (config: PiAgentConfig, agent: BackofficeAgentContext) => readonly Extension[];
  settings: HarnessSettings;
  report: (error: unknown) => void;
};

export type OpenPiAgent = {
  harness: Harness;
  storage: Storage;
  billing: PiBilling | null;
  /** Installs the workspace's current extensions with the authority of the given turn. */
  refreshWorkspaceExtensions: (turn: PiAgentTurn) => Promise<void>;
  /** Records every answered turn not yet reported as a `pi` Automations event. */
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
    report: (error) => {
      console.error(error);
    },
  };
}

/** Rebuilds an agent's registry and opens its root conversation; authority comes from its turns. */
export async function openPiAgentHarness(input: {
  config: PiAgentConfig;
  runtime: BackofficeRuntimeServices;
  dependencies: PiAgentDependencies;
  openStorage: () => Promise<Storage>;
  nowEpochMs: () => number;
}): Promise<OpenPiAgent> {
  const { config, runtime, dependencies } = input;
  let opened: { harness: Harness; storage: Storage } | null = null;
  const agent = createBackofficeAgentContext({
    config,
    runtime,
    readActiveTurn: async (context) =>
      opened ? await readActivePiAgentTurn(opened.harness, opened.storage, context) : null,
  });
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
    ...dependencies.extensions(config, agent),
    createBackofficeExtension(agent),
    ...(billing ? [billing.extension] : []),
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
      onReport: dependencies.report,
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
    nowEpochMs: input.nowEpochMs,
    report: dependencies.report,
  });
  let workspaceExtensions: LoadedWorkspaceExtensions | null = null;
  let refreshing = Promise.resolve();
  // A shared agent has no fresh session to pick up rebuilt extensions, so each turn checks for them.
  async function refreshWorkspaceExtensions(turn: PiAgentTurn) {
    refreshing = refreshing
      .then(async () => {
        const reloaded = await loadWorkspaceExtensions({
          agent,
          turn: agent.turn(turn),
          registry: registry.snapshot(),
          loaded: workspaceExtensions,
          report: dependencies.report,
        });
        if (!reloaded) {
          return;
        }
        for (const extension of workspaceExtensions?.extensions ?? []) {
          registry.uninstall(extension);
        }
        for (const extension of reloaded.extensions) {
          registry.install(extension);
        }
        workspaceExtensions = reloaded;
      })
      .catch(dependencies.report);
    await refreshing;
  }
  try {
    await harness.root(BACKGROUND_CONTEXT, { agent: { thinkingLevel: PI_THINKING_LEVEL } });
    // Recovered work resumes with the extensions it ran with before the restart.
    const recovering = await readActivePiAgentTurn(harness, storage, BACKGROUND_CONTEXT);
    if (recovering) {
      await refreshWorkspaceExtensions(recovering);
    }
  } catch (cause) {
    await harness.close(BACKGROUND_CONTEXT);
    throw cause;
  }
  return { harness, storage, billing, refreshWorkspaceExtensions, reportSettledTurns };
}
