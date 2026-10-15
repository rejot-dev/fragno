import { Button } from "./button";
import { BackofficeTabHeader } from "./tab-header";

export default { title: "Navigation/Tab header" };

export function SingleTab() {
  return (
    <BackofficeTabHeader
      items={[{ id: "sandboxes", label: "Sandboxes", to: "/sandboxes", active: true }]}
      ariaLabel="Computer kinds"
      options={null}
    />
  );
}

export function WithOptions() {
  return (
    <BackofficeTabHeader
      items={[
        { id: "all", label: "All agents", to: "/agents", groupId: "overview", active: true },
        { id: "assistant", label: "Assistant", to: "/agents/assistant", groupId: "agents" },
        { id: "reviewer", label: "Reviewer", to: "/agents/reviewer", groupId: "agents" },
      ]}
      ariaLabel="Agents"
      options={<Button variant="secondary">New agent</Button>}
    />
  );
}
