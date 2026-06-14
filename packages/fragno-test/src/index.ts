// Re-export utilities from @fragno-dev/core/test
export {
  createFragmentForTest,
  type CreateFragmentForTestOptions,
  type RouteHandlerInputOptions,
} from "@fragno-dev/core/test";

// Re-export adapter types
export type {
  SupportedAdapter,
  KyselySqliteAdapter,
  KyselyPgliteAdapter,
  DrizzlePgliteAdapter,
  InMemoryAdapterConfig,
  AdapterContext,
} from "./adapters";

// Re-export new builder-based database test utilities
export { buildDatabaseFragmentsTest, DatabaseFragmentsTestBuilder } from "./db-test";
export type { AdditionalFragmentRuntime, AnyFragmentResult } from "./db-test";
export { drainDurableHooks } from "./durable-hooks";
export type { DrainDurableHooksMode, DrainDurableHooksOptions } from "./durable-hooks";
export { createTestDb } from "./test-db";
export type { TestDb } from "./test-db";
export {
  createFragmentTestClientConfig,
  createFragmentTestFetcher,
  waitForStore,
} from "./client-flow";
export type {
  FragmentTestClientConfigOptions,
  FragmentTestFetcherOptions,
  SubscribableStore,
} from "./client-flow";
export {
  createCommonTestContextMethods,
  type BaseTestContext,
  type InternalTestContextMethods,
  type TestContext,
} from "./common-test-context";
