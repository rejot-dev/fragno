import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { createDurableHooksProcessor, migrate, type DatabaseAdapter } from "@fragno-dev/db";
import { createDurableHooksDispatcher } from "@fragno-dev/db/dispatchers/node";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowsFragmentConfig,
} from "@fragno-dev/workflows";

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
  const runtime = defaultFragnoRuntime;
  let runner: ReturnType<typeof createWorkflowsRunner> | null = null;

  const config: WorkflowsFragmentConfig = {
    workflows,
    runtime,
  };
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowsRoutesFactory])
    .withOptions({ databaseAdapter: adapter })
    .build();

  runner = createWorkflowsRunner({ fragment, workflows, runtime });
  config.runner = runner;

  const processor = createDurableHooksProcessor(fragment);
  if (!processor) {
    throw new Error("Durable hooks not configured for workflows fragment.");
  }

  const dispatcher = createDurableHooksDispatcher({
    processor,
    pollIntervalMs: 2000,
    onError: (error) => {
      console.error("Workflows durable hooks dispatcher failed", error);
    },
  });

  return { fragment, dispatcher };
}

async function createServer(): Promise<WorkflowsServer> {
  const adapter = createWorkflowsAdapter();
  const { fragment, dispatcher } = createWorkflowsFragmentServer(adapter);

  await migrate(fragment);
  if (process.env["WF_DISABLE_INTERNAL_DISPATCHER"] !== "1") {
    dispatcher.startPolling();
  }

  return {
    fragment,
    dispatcher,
  };
}
