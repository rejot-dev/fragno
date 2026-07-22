import { assert, describe, it } from "vitest";

import { resolveDatabaseNamespace, sanitizeNamespace } from "./database-namespace";

describe("database namespaces", () => {
  it("sanitizes dashed logical schema names for the default physical namespace", () => {
    assert(sanitizeNamespace("pi-harness") === "pi_harness");
    assert(resolveDatabaseNamespace("pi-harness") === "pi_harness");
  });

  it("preserves explicit physical namespace choices", () => {
    assert(resolveDatabaseNamespace("pi-harness", "tenant-a") === "tenant-a");
    assert(resolveDatabaseNamespace("pi-harness", null) === null);
  });
});
