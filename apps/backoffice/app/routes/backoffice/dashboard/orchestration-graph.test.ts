import { describe, expect, test } from "vitest";

import type { AutomationForwardAccept } from "@fragno-dev/backoffice-api/v0/automation";

import { projectOrchestrationGraph } from "./orchestration-graph";

function accept(id: string, matcher: AutomationForwardAccept["matcher"]): AutomationForwardAccept {
  return {
    id,
    name: id,
    enabled: true,
    from: { kind: "members" },
    matcher,
    description: null,
  };
}

const ALL_BANK = accept("A-all-bank", { path: "$.source", op: "eq", value: "bank" });
const BANK_BALANCE = accept("B-bank-balance", {
  all: [
    { path: "$.source", op: "eq", value: "bank" },
    { path: "$.eventType", op: "eq", value: "balance.updated" },
  ],
});

/** Each inlet's events, when the scope knows of no events but what its accepts name. */
function inletEvents(forwardAccepts: AutomationForwardAccept[]) {
  const graph = projectOrchestrationGraph({
    scopeLabel: "Ada Labs",
    sources: [],
    eventDefinitions: [],
    routes: [],
    activeWorkflows: [],
    recentEvents: [],
    forwardAccepts,
    recentForwards: [],
  });
  return Object.fromEntries(graph.inlets.map(({ label, eventIds }) => [label, eventIds]));
}

describe("forward accepts on the orchestration graph", () => {
  test("an accept pinned to a source reaches the events another accept names, in any order", () => {
    const expected = {
      "A-all-bank": ["bank:balance.updated"],
      "B-bank-balance": ["bank:balance.updated"],
    };
    expect(inletEvents([ALL_BANK, BANK_BALANCE])).toEqual(expected);
    expect(inletEvents([BANK_BALANCE, ALL_BANK])).toEqual(expected);
  });
});
