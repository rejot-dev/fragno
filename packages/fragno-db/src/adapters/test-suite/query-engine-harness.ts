import type { DatabaseAdapter } from "../adapters";

export interface QueryEngineSuiteContext {
  // oxlint-disable-next-line no-explicit-any
  adapter: DatabaseAdapter<any>;
  close?: () => Promise<void> | void;
}

export interface QueryEngineSuiteHarness {
  name: string;
  createAdapter: () => Promise<QueryEngineSuiteContext>;
  reuseContext?: boolean;
  resetContext?: (context: QueryEngineSuiteContext) => Promise<void> | void;
  capabilities?: {
    constraints?: boolean;
    databaseDefaultTimestamp?: boolean;
  };
}

export const suiteCapability = (
  capabilities: QueryEngineSuiteHarness["capabilities"],
  capability: keyof NonNullable<QueryEngineSuiteHarness["capabilities"]>,
): boolean => capabilities?.[capability] ?? true;
