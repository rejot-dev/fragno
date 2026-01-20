import { instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "@fragno-dev/db";
import { migrate } from "@fragno-dev/db";
import {
  aiFragmentDefinition,
  aiRoutesFactory,
  aiSchema,
  createAiRunner,
  type AiFragmentConfig,
} from "@fragno-dev/fragment-ai";
import { createInProcessDispatcher } from "@fragno-dev/dispatcher-node";

import { createAiAdapter } from "./adapter.server";

export type AiServer = ReturnType<typeof createAiFragmentServer>;

let serverPromise: Promise<AiServer> | null = null;

export function getAiServer() {
  if (!serverPromise) {
    serverPromise = createServer();
  }
  return serverPromise;
}

// oxlint-disable-next-line no-explicit-any
export function createAiFragmentServer(adapter: DatabaseAdapter<any>) {
  const fragmentConfig: AiFragmentConfig = {
    getApiKey: () => process.env["OPENAI_API_KEY"],
    defaultModel: { id: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini" },
  };

  const db = adapter.createQueryEngine(aiSchema, "ai");
  const runner = createAiRunner({ db, config: fragmentConfig });
  const dispatcher = createInProcessDispatcher({
    wake: () => {
      Promise.resolve(
        runner.tick({
          maxRuns: 3,
          maxWebhookEvents: 5,
        }),
      ).catch((error: unknown) => {
        console.error("AI runner tick failed", error);
      });
    },
    pollIntervalMs: 1000,
  });

  const fragment = instantiate(aiFragmentDefinition)
    .withConfig({
      ...fragmentConfig,
      runner,
      dispatcher,
    })
    .withRoutes([aiRoutesFactory])
    .withOptions({ databaseAdapter: adapter })
    .build();

  return { fragment, dispatcher };
}

async function createServer(): Promise<AiServer> {
  const adapter = createAiAdapter();
  const { fragment, dispatcher } = createAiFragmentServer(adapter);

  await migrate(fragment);
  dispatcher.startPolling();

  return {
    fragment,
    dispatcher,
  };
}
