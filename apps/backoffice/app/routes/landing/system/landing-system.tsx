import { AutomationOrchestration } from "./automation-orchestration";
import { DurableWorkspace } from "./durable-workspace";
import { MarketplaceAgents } from "./marketplace-agents";

export function LandingSystem() {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-28 px-5 py-28 sm:px-8 lg:px-12 lg:py-36">
      <DurableWorkspace />
      <AutomationOrchestration />
      <MarketplaceAgents />
    </div>
  );
}
