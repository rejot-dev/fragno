import { UNIVERSE } from "./orchestration-graph-story-support";
import { OrchestrationUniverseGraph } from "./orchestration-universe";

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
