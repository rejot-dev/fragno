import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { createDurableHooksProcessor } from "@fragno-dev/db/dispatchers/node";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { PostgresDialect } from "@fragno-dev/db/dialects";
import { NodePostgresDriverConfig } from "@fragno-dev/db/drivers";
import {
  workflowsFragmentDefinition,
  workflowsRoutesFactory,
  type WorkflowsFragmentConfig,
} from "@fragno-dev/workflows";

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
  runtime,
};

const fragment = instantiate(workflowsFragmentDefinition)
  .withConfig(config)
  .withRoutes([workflowsRoutesFactory])
  .withOptions({ databaseAdapter: adapter })
  .build();

createDurableHooksProcessor([fragment]);

const start = Date.now();
console.log(`[migration-edge] start pid=${process.pid}`);
await migrate(fragment);
const elapsedMs = Date.now() - start;
console.log(`[migration-edge] complete pid=${process.pid} elapsedMs=${elapsedMs}`);
