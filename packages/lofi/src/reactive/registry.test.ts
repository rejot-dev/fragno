import { describe, expect, it, assert } from "vitest";

import { InMemoryLofiAdapter } from "../adapters/in-memory/adapter";
import { createLofiRuntimeRegistry } from "./registry";
import { createLofiRuntime } from "./runtime";
import { reactiveTestSchema } from "./test-utils";

describe("createLofiRuntimeRegistry", () => {
  it("reuses runtimes for the same key and creates separate runtimes for separate keys", () => {
    const registry = createLofiRuntimeRegistry({
      getKey: (scope: { orgId: string }) => scope.orgId,
      createRuntime: ({ orgId }) =>
        createLofiRuntime({
          endpointName: "app",
          adapter: new InMemoryLofiAdapter({
            endpointName: "app",
            schemas: [reactiveTestSchema],
          }),
          sources: [{ id: orgId, outboxUrl: `https://example.com/${orgId}/outbox` }],
          fetch: (async () => new Response(JSON.stringify([]))) as typeof fetch,
        }),
    });

    const orgA1 = registry.get({ orgId: "org-a" });
    const orgA2 = registry.get({ orgId: "org-a" });
    const orgB = registry.get({ orgId: "org-b" });

    expect(orgA1).toBe(orgA2);
    expect(orgA1).not.toBe(orgB);
    assert(registry.has({ orgId: "org-a" }));
    expect(registry.entries()).toHaveLength(2);

    assert(registry.delete({ orgId: "org-a" }));
    assert(!registry.has({ orgId: "org-a" }));

    registry.clear();
    expect(registry.entries()).toHaveLength(0);
  });
});
