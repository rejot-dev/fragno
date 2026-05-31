import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";
import type { WorkflowsFragmentConfig } from "@fragno-dev/workflows/workflow";

import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { workflowsFragmentDefinition, workflowsRoutesFactory } from "@fragno-dev/workflows";

import { getPostgresPool } from "../../../example-apps/wf-example/app/db/db.server";
import { workflows } from "../../../example-apps/wf-example/app/workflows/workflows";

const dialect = new PostgresDialect({ pool: getPostgresPool() });
const adapter = new SqlAdapter({
  dialect,
  driverConfig: new NodePostgresDriverConfig(),
});

const runtime = defaultFragnoRuntime;
const config: WorkflowsFragmentConfig = {
  workflows,
  runtime,
};
const stuckProcessingTimeoutMinutes = Number(
  process.env.WF_STUCK_PROCESSING_TIMEOUT_MINUTES ?? Number.NaN,
);

const fragment = instantiate(workflowsFragmentDefinition)
  .withConfig(config)
  .withRoutes([workflowsRoutesFactory])
  .withOptions({
    databaseAdapter: adapter,
    durableHooks: Number.isFinite(stuckProcessingTimeoutMinutes)
      ? { stuckProcessingTimeoutMinutes }
      : undefined,
  })
  .build();

const dispatcher = createDurableHooksProcessor([fragment], {
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
