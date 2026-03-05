import { useOutletContext } from "react-router";
import type { DurableHooksOrgOutletContext } from "./durable-hooks-organisation";
import DurableHookDetailPanel from "./durable-hooks-organisation-detail";

export default function BackofficeDurableHooksIndex() {
  const { hooks, selectedHookId, onSelectHook } = useOutletContext<DurableHooksOrgOutletContext>();
  const hook = hooks.find((item) => item.id === selectedHookId) ?? null;

  if (!hook) {
    return (
      <div className="text-sm text-[var(--bo-muted)]">
        Select a durable hook to review its payload and error details.
      </div>
    );
  }

  return <DurableHookDetailPanel hook={hook} onBack={() => onSelectHook(null)} />;
}
