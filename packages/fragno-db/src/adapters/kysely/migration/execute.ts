import type { CustomOperation, MigrationOperation } from "../../../migration-engine/shared";
import type { KyselyConfig } from "../kysely-adapter";
import type { TableNameMapper } from "../kysely-shared";
import type { ExecuteNode } from "./execute-base";
import { createMigrationExecutor } from "./execute-factory";

export type { ExecuteNode };

/**
 * Execute a single migration operation using the appropriate provider-specific executor.
 *
 * @param operation - The migration operation to execute
 * @param config - Kysely configuration with database instance and provider
 * @param onCustomNode - Handler for custom operations
 * @param mapper - Optional table name mapper for namespacing
 * @returns ExecuteNode(s) that can be compiled to SQL or executed
 */
export function execute(
  operation: MigrationOperation,
  config: KyselyConfig,
  onCustomNode: (op: CustomOperation) => ExecuteNode | ExecuteNode[],
  mapper?: TableNameMapper,
): ExecuteNode | ExecuteNode[] {
  // For custom operations, use the provided handler
  if (operation.type === "custom") {
    return onCustomNode(operation);
  }

  const executor = createMigrationExecutor(config);
  return executor.executeOperation(operation, mapper);
}

/**
 * Preprocess a batch of migration operations.
 * This allows provider-specific transformations before execution.
 *
 * For example, SQLite merges add-foreign-key operations into create-table operations
 * since foreign keys must be defined at table creation time.
 *
 * @param operations - The migration operations to preprocess
 * @param config - Kysely configuration with database instance and provider
 * @returns Preprocessed migration operations
 */
export function preprocessOperations(
  operations: MigrationOperation[],
  config: KyselyConfig,
): MigrationOperation[] {
  const executor = createMigrationExecutor(config);
  return executor.preprocessOperations(operations);
}
