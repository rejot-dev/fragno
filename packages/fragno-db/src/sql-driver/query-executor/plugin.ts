/**
 * Adapted from Kysely's KyselyPlugin
 * Modified from: https://github.com/kysely-org/kysely
 * License: MIT
 * Copyright (c) 2022 Sami Koskimäki
 *
 * Simplified to only support transformResult.
 */

import type { QueryResult } from "../sql-driver";

export interface GenericSQLPlugin {
  /**
   * This method is called for each query after it has been executed.
   * You can modify the result and return the modified result.
   */
  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<unknown>>;
}

export interface PluginTransformResultArgs {
  readonly result: QueryResult<unknown>;
}
