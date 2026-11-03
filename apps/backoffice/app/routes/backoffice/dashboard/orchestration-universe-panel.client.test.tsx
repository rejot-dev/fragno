// @vitest-environment happy-dom

import { afterEach, assert, beforeEach, test, vi } from "vitest";

import type { OrchestrationGraph } from "@fragno-private/design-system/orchestration/orchestration-graph-model";
import type { OrchestrationUniverse } from "@fragno-private/design-system/orchestration/orchestration-universe-model";

import { cleanup, render, screen } from "@testing-library/react";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

const { graphReads, deliveryReads, noPrograms } = vi.hoisted(() => ({
  // What each replica's graph and delivery reads return, by the replica's name.
  graphReads: new Map<string, unknown>(),
  deliveryReads: new Map<string, unknown>(),
  // No workflow has run, so none calls an outside system. A read returns the same data until it
  // changes, as a replica view does.
  noPrograms: { status: "ready", data: [] },
}));

// A replica here is only its name, which picks the reads above.
vi.mock("@/fragno/automation/lofi/replica", () => ({
  useAutomationReplica: (source: { replicaName: string }) => ({
    replica: source.replicaName,
    caughtUp: true,
    fraction: null,
    error: null,
  }),
  useAutomationRead: (replica: string | null, read: string) =>
    read === "latestWorkflowPrograms"
      ? noPrograms
      : ((replica && deliveryReads.get(replica)) ?? { status: "loading" }),
}));
vi.mock("./scope-orchestration-graph", () => ({
  useScopeOrchestrationGraph: (replica: string | null) =>
    (replica && graphReads.get(replica)) ?? { status: "loading" },
}));
// The universe's drawing is the design system's; this names the planets it was given.
vi.mock("@fragno-private/design-system/orchestration/orchestration-universe", () => ({
  OrchestrationUniverseGraph: ({ universe }: { universe: OrchestrationUniverse }) => (
    <ul>
      {universe.scopes.map((scope) => (
        <li key={scope.id}>{scope.graph.scopeLabel}</li>
      ))}
    </ul>
  ),
}));

import { OrganizationUniverse } from "./orchestration-universe-panel";

const organization = { id: "org-1", slug: "ada-labs", name: "Ada Labs", jurisdiction: null };
const selectedScope = {
  kind: "org",
  organization,
  label: "Ada Labs",
} as unknown as BackofficeScopeSelection;

function graph(scopeLabel: string): OrchestrationGraph {
  return { scopeLabel, inlets: [], sources: [], events: [], routes: [], targets: [] };
}

function readyGraph(scopeLabel: string, recordErrors: string[] = []) {
  return {
    status: "ready",
    graph: graph(scopeLabel),
    inputs: { routes: [], forwardAccepts: [], recentForwards: [] },
    catalog: { sources: [], events: [] },
    recordErrors,
  };
}

const books = {
  label: "Books",
  source: {
    replicaName: "books",
    resolvedScope: {
      kind: "project",
      owner: { kind: "org", organization },
      project: { id: "books" },
    },
    adapterIdentity: "books",
  },
};

function renderUniverse() {
  return render(
    <OrganizationUniverse
      replica={"organization" as never}
      selectedScope={selectedScope}
      scopes={{ projects: [books] as never, viewer: null, memberNames: {}, problems: [] }}
      runtimeToolCatalog={[]}
    />,
  );
}

beforeEach(() => {
  graphReads.clear();
  deliveryReads.clear();
});

afterEach(cleanup);

test("names why the universe could not be read when the organization's deliveries fail", () => {
  graphReads.set("organization", readyGraph("Ada Labs"));
  deliveryReads.set("organization", { status: "error", message: "The replica is corrupt." });

  renderUniverse();

  screen.getByText("The universe could not be read.");
  screen.getByText("The replica is corrupt.");
  assert.isNull(screen.queryByText("Reading the organization's routes and events"));
});

test("warns that planets drawn without some of their records may be incomplete", () => {
  const unread = ["Event sources", "event definitions", "running workflows"];
  graphReads.set("organization", readyGraph("Ada Labs", unread));
  graphReads.set("books", readyGraph("Books", unread));
  deliveryReads.set("organization", { status: "ready", data: [] });
  deliveryReads.set("books", { status: "ready", data: [] });

  renderUniverse();

  screen.getByText(
    "Event sources, event definitions, running workflows of Ada Labs and Books could not be " +
      "read, so the universe may be incomplete.",
  );
  // What was read is still drawn.
  screen.getByText("Books");
});
