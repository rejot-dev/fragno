import { runInDurableObject } from "cloudflare:test";
import { assert, describe, test } from "vitest";

import { env } from "cloudflare:workers";

import { encodeBackofficeObjectAddress } from "@/backoffice-runtime/object-registry";

describe("page queries checked in an Automations object's facet", () => {
  test("reports columns and errors, and keeps nothing a query changed", async () => {
    const automations = env.AUTOMATIONS.getByName(
      encodeBackofficeObjectAddress({
        binding: "AUTOMATIONS",
        scope: { kind: "org", orgId: `org-${crypto.randomUUID()}`, jurisdiction: null },
      }),
    );

    const first = await automations.checkPageQueries([
      { sql: "SELECT instanceId, status FROM runs WHERE createdAt > ?1", params: [0] },
      { sql: "SELECT instanceId FROM runs ORDER BY statsu", params: [] },
      { sql: "SELECT ?1 AS one", params: [] },
      { sql: "DROP VIEW runs", params: [] },
      { sql: "SELECT agentName FROM agents", params: [] },
    ]);
    assert.deepEqual(first[0], { kind: "ran", columns: ["instanceId", "status"] });
    assert(first[1]?.kind === "failed");
    assert.include(first[1].message, "no such column: statsu");
    assert.equal(first[2]?.kind, "failed");
    assert.deepEqual(first[3], { kind: "ran", columns: [] });
    assert.deepEqual(first[4], { kind: "ran", columns: ["agentName"] });

    // The dropped view is back for the next check.
    const second = await automations.checkPageQueries([
      { sql: "SELECT instanceId FROM runs", params: [] },
    ]);
    assert.deepEqual([...second], [{ kind: "ran", columns: ["instanceId"] }]);

    // Miniflare lists a facet's database file as an object of the namespace, which the drain in
    // vitest-codemode-setup.ts cannot address.
    await runInDurableObject(automations, (_object, state) => {
      state.facets.delete("sql-query-checker");
    });
  });
});
