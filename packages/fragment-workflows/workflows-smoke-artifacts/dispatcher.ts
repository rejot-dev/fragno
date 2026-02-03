import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { createDurableHooksDispatcher } from "@fragno-dev/db/dispatchers/node";
import { createDurableHooksProcessor, migrate } from "@fragno-dev/db";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";
import {
  createWorkflowsRunner,
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowsFragmentConfig,
} from "@fragno-dev/fragment-workflows";

import { getPostgresPool } from "/Users/wilco/.superset/worktrees/fragno/workflows-smoke-test/example-apps/wf-example/app/db/db.server";
import { workflows } from "/Users/wilco/.superset/worktrees/fragno/workflows-smoke-test/example-apps/wf-example/app/workflows/workflows";

const dialect = new PostgresDialect({ pool: getPostgresPool() });
const adapter = new SqlAdapter({
  dialect,
  driverConfig: new NodePostgresDriverConfig(),
});

const runtime = defaultFragnoRuntime;
const config: WorkflowsFragmentConfig = {
  workflows,
  enableRunnerTick: true,
  runtime,
};

const fragment = instantiate(workflowsFragmentDefinition)
  .withConfig(config)
  .withRoutes([workflowsRoutesFactory])
  .withOptions({ databaseAdapter: adapter })
  .build();

const runner = createWorkflowsRunner({ fragment, workflows, runtime });
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

await migrate(fragment);

dispatcher.startPolling();
console.log(`[dispatcher] started pid=${process.pid}`);

const shutdown = () => {
  dispatcher.stopPolling();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {}, 1 << 30);
