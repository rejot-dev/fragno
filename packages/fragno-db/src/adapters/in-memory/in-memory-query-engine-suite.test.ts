import { describeQueryEngineSuite } from "../test-suite/query-engine-suite";
import { InMemoryAdapter } from "./in-memory-adapter";

describeQueryEngineSuite({
  name: "in-memory",
  createAdapter: async () => {
    const adapter = new InMemoryAdapter({ idSeed: "query-engine-suite" });
    return { adapter, close: () => adapter.close() };
  },
  capabilities: {
    databaseDefaultTimestamp: false,
  },
});
