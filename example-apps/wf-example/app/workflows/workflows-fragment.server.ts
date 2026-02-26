import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import {
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowsFragmentConfig,
} from "@fragno-dev/workflows";

import { createWorkflowsAdapter } from "./adapter.server";
import { workflows } from "./workflows";
import { getShardFromHeaders } from "~/sharding.server";

export type WorkflowsInit = { type: "dry-run" } | { type: "live" };

export function createWorkflowsFragmentServer(init: WorkflowsInit) {
  const runtime = defaultFragnoRuntime;

  const config: WorkflowsFragmentConfig = {
    workflows,
    runtime,
  };

  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes([workflowsRoutesFactory])
    .withOptions({
      databaseAdapter:
        init.type === "live" ? createWorkflowsAdapter() : createWorkflowsAdapter(undefined),
      shardingStrategy: { mode: "row" },
    })
    .build();

  fragment.withMiddleware(async ({ headers }, { deps }) => {
    const shard = getShardFromHeaders(headers);
    deps.shardContext.set(shard);
    return undefined;
  });

  if (init.type === "dry-run") {
    return { fragment, dispatcher: null };
  }

  const dispatcher = createDurableHooksProcessor([fragment], {
    pollIntervalMs: 200,
    onError: (error) => {
      console.error("Workflows durable hooks dispatcher failed", error);
    },
  });

  return { fragment, dispatcher };
}

export type WorkflowsServer = ReturnType<typeof createWorkflowsFragmentServer>;

let serverPromise: Promise<WorkflowsServer> | null = null;

export function getWorkflowsServer() {
  if (!serverPromise) {
    serverPromise = createServer();
  }
  return serverPromise;
}

async function createServer(): Promise<WorkflowsServer> {
  const { fragment, dispatcher } = createWorkflowsFragmentServer({ type: "live" });
  if (dispatcher && process.env["WF_DISABLE_INTERNAL_DISPATCHER"] !== "1") {
    dispatcher.startPolling();
  }

  return { fragment, dispatcher };
}

export const fragment = createWorkflowsFragmentServer({ type: "dry-run" }).fragment;
