import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import type { DatabaseAdapter } from "@fragno-dev/db";
import { migrate } from "@fragno-dev/db";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  workflowsSchema,
} from "@fragno-dev/fragment-workflows";
import { createInProcessDispatcher } from "@fragno-dev/workflows-dispatcher-node";

import { createWorkflowsAdapter } from "./adapter.server";
import { workflows } from "./workflows";

export type WorkflowsServer = ReturnType<typeof createWorkflowsFragmentServer>;

let serverPromise: Promise<WorkflowsServer> | null = null;

export function getWorkflowsServer() {
  if (!serverPromise) {
    serverPromise = createServer();
  }
  return serverPromise;
}

// oxlint-disable-next-line no-explicit-any
export function createWorkflowsFragmentServer(adapter: DatabaseAdapter<any>) {
  const db = adapter.createQueryEngine(workflowsSchema, "workflows");
  const runtime = defaultFragnoRuntime;
  const runner = createWorkflowsRunner({ db, workflows, runtime });
  const dispatcher = createInProcessDispatcher({
    wake: () => {
      Promise.resolve(runner.tick({ maxInstances: 5, maxSteps: 50 })).catch((error: unknown) => {
        console.error("Workflows runner tick failed", error);
      });
    },
    pollIntervalMs: 2000,
  });

  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig({ workflows, runner, dispatcher, enableRunnerTick: true, runtime })
    .withRoutes([workflowsRoutesFactory])
    .withOptions({ databaseAdapter: adapter })
    .build();

  return { fragment, dispatcher };
}

async function createServer(): Promise<WorkflowsServer> {
  const adapter = createWorkflowsAdapter();
  const { fragment, dispatcher } = createWorkflowsFragmentServer(adapter);

  await migrate(fragment);
  dispatcher.startPolling();

  return {
    fragment,
    dispatcher,
  };
}
