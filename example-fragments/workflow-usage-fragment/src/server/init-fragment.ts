import { defaultFragnoRuntime, instantiate } from "@fragno-dev/core";
import { migrate } from "@fragno-dev/db";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { SqliteDialect } from "@fragno-dev/db/dialects";
import { BetterSQLite3DriverConfig } from "@fragno-dev/db/drivers";
import { workflowsFragmentDefinition } from "@fragno-dev/workflows";
import Database from "better-sqlite3";

import type { WorkflowUsageAgentDefinition } from "../fragment/dsl";
import {
  createWorkflowUsageFragment,
  usageRequiredWorkflows,
  type WorkflowUsageConfig,
} from "../fragment/index";

const DEFAULT_DB_PATH = "./usage-fragment.sqlite";

export type InitFragmentOptions = {
  agents: Record<string, WorkflowUsageAgentDefinition>;
  databasePath?: string;
};

export async function initFragment(options: InitFragmentOptions) {
  const dbPath = options.databasePath ?? DEFAULT_DB_PATH;
  const sqliteDatabase = new Database(dbPath);
  const dialect = new SqliteDialect({ database: sqliteDatabase });
  const adapter = new SqlAdapter({
    dialect,
    driverConfig: new BetterSQLite3DriverConfig(),
  });

  const workflowsConfig = {
    runtime: defaultFragnoRuntime,
    workflows: { ...usageRequiredWorkflows },
  };

  const workflowsFragment = instantiate(workflowsFragmentDefinition)
    .withConfig(workflowsConfig)
    .withRoutes([])
    .withOptions({ databaseAdapter: adapter, outbox: { enabled: false } })
    .build();

  const usageConfig: WorkflowUsageConfig = {
    agents: options.agents,
    onSessionCompleted(payload) {
      console.log("onSessionCompleted", payload);
    },
  };

  const usageFragment = createWorkflowUsageFragment(
    usageConfig,
    { databaseAdapter: adapter, outbox: { enabled: false } },
    { workflows: workflowsFragment.services },
  );

  await migrate(workflowsFragment);
  await migrate(usageFragment);

  const close = async () => {
    await adapter.close();
  };

  return {
    fragment: usageFragment,
    workflowsFragment,
    adapter,
    databasePath: dbPath,
    close,
  };
}
