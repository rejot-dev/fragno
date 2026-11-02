// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { FORWARDED_IN_GRAPH } from "./orchestration-graph-story-support";
import { OrchestrationLayeredGraph } from "./orchestration-layered-graph";

afterEach(cleanup);

function renderGraph(graph = FORWARDED_IN_GRAPH) {
  return render(
    <OrchestrationLayeredGraph graph={graph} selected={null} onSelect={() => {}} pulses={[]} />,
  );
}

/** Whether `element` sits inside something `hidden` keeps from showing. */
function isHidden(element: Element): boolean {
  return element.closest(".hidden") !== null;
}

test("a search that only an inlet matches shows that inlet", async () => {
  const view = renderGraph();
  await act(async () => {
    fireEvent.change(view.getByPlaceholderText("Search sources, events, routes, workflows"), {
      target: { value: "Jan" },
    });
  });

  assert.isNull(view.queryByText(/Nothing matches/));
  const inlet = view.getByRole("button", { name: /^Jan's large transfers inlet/ });
  assert.isFalse(isHidden(inlet));
});

test("a scope wired only through a catch-all inlet is drawn", () => {
  const view = renderGraph({
    ...FORWARDED_IN_GRAPH,
    inlets: FORWARDED_IN_GRAPH.inlets.filter((inlet) => inlet.eventIds === null),
    sources: [],
    events: [],
    routes: [],
    targets: [],
  });

  assert.isNull(view.queryByText("Nothing is routed yet."));
  assert.isFalse(isHidden(view.getByRole("button", { name: /^Jan's large transfers inlet/ })));
});
