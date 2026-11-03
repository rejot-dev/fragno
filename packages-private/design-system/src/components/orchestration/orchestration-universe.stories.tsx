import { useEffect, useState } from "react";

import { UNIVERSE } from "./orchestration-graph-story-support";
import { OrchestrationUniverseGraph } from "./orchestration-universe";
import type {
  OrchestrationUniverse,
  OrchestrationUniverseScope,
} from "./orchestration-universe-model";

export default { title: "Orchestration/Universe", parameters: { layout: "fullscreen" } };

export function Organization() {
  return (
    <div className="h-screen p-4">
      <OrchestrationUniverseGraph universe={UNIVERSE} />
    </div>
  );
}

export function TwoScopes() {
  return (
    <div className="h-screen p-4">
      <OrchestrationUniverseGraph
        universe={{
          ...UNIVERSE,
          scopes: UNIVERSE.scopes.filter((scope) => scope.id === "org" || scope.id === "website"),
          forwards: UNIVERSE.forwards.filter((forward) => forward.toScopeId === "website"),
        }}
      />
    </div>
  );
}

/**
 * Forwards into a project that listens to none of their events land side by side on a stretch of
 * its orbit.
 */
export function UnroutedForwards() {
  const organization = UNIVERSE.scopes.find((scope) => scope.id === "org")!;
  const website = UNIVERSE.scopes.find((scope) => scope.id === "website")!;
  const forwarded = new Set(
    organization.graph.routes
      .filter(({ id }) => id === "org-intake" || id === "org-receipts")
      .map(({ eventId }) => eventId),
  );
  return (
    <div className="h-screen p-4">
      <OrchestrationUniverseGraph
        universe={{
          ...UNIVERSE,
          scopes: [
            organization,
            {
              ...website,
              graph: {
                ...website.graph,
                routes: website.graph.routes.filter(({ eventId }) => !forwarded.has(eventId)),
              },
            },
          ],
          forwards: [
            { routeId: "org-intake", fromScopeId: "org", toScopeId: "website" },
            { routeId: "org-receipts", fromScopeId: "org", toScopeId: "website" },
          ],
        }}
      />
    </div>
  );
}

/** Scopes still being read ring their planet: by how far they got, or turning until that is known. */
export function ReadingScopes() {
  const empty = (scopeLabel: string) => ({
    scopeLabel,
    inlets: [],
    sources: [],
    events: [],
    routes: [],
    targets: [],
  });
  return (
    <div className="h-screen p-4">
      <OrchestrationUniverseGraph
        universe={{
          ...UNIVERSE,
          scopes: [
            ...UNIVERSE.scopes.filter((scope) => scope.id === "org"),
            {
              id: "website",
              graph: empty("Website"),
              status: { kind: "loading", fraction: 0.4 },
            },
            { id: "books", graph: empty("Books"), status: { kind: "loading", fraction: null } },
            {
              id: "archive",
              graph: empty("Archive"),
              status: { kind: "failed", message: "The project's backend did not answer." },
            },
          ],
          forwards: UNIVERSE.forwards.filter((forward) => forward.toScopeId === "website"),
        }}
      />
    </div>
  );
}

const LOADING_TICK_MS = 200;
const LOADING_LOOP_MS = 16_000;

/**
 * When each scope's replica opens, says how far it got, and catches up, in milliseconds into the
 * loop; scopes without one were read before the universe opened.
 */
const LOADING_SCHEDULE: Record<string, { known: number; caughtUp: number }> = {
  website: { known: 2_000, caughtUp: 8_000 },
  bookkeeping: { known: 4_000, caughtUp: 14_000 },
};

function loadingScope(scope: OrchestrationUniverseScope, elapsed: number) {
  const schedule = LOADING_SCHEDULE[scope.id];
  if (!schedule || elapsed >= schedule.caughtUp) {
    return scope;
  }
  const empty = { ...scope.graph, inlets: [], sources: [], events: [], routes: [], targets: [] };
  const fraction =
    elapsed < schedule.known
      ? null
      : (elapsed - schedule.known) / (schedule.caughtUp - schedule.known);
  return { ...scope, graph: empty, status: { kind: "loading", fraction } as const };
}

/**
 * The universe as it opens: projects ring while their replicas download, turning until they know
 * how far they got, and draw their graphs once caught up. It starts over every 16 seconds.
 */
export function Loading() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((current) => (current + LOADING_TICK_MS) % LOADING_LOOP_MS);
    }, LOADING_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);
  // System forwards into every organization, so an organization's universe leaves it out.
  const universe: OrchestrationUniverse = {
    ...UNIVERSE,
    scopes: UNIVERSE.scopes
      .filter((scope) => scope.id !== "system")
      .map((scope) => loadingScope(scope, elapsed)),
    forwards: UNIVERSE.forwards.filter((forward) => forward.fromScopeId !== "system"),
  };
  return (
    <div className="h-screen p-4">
      <OrchestrationUniverseGraph universe={universe} />
    </div>
  );
}
