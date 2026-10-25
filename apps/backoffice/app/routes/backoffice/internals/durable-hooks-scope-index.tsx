import { BackofficeSystemState } from "@fragno-private/design-system/system-state";

export default function BackofficeDurableHooksScopeIndex() {
  return (
    <BackofficeSystemState
      tone="empty"
      label="Durable hook"
      title="Select a hook to inspect it."
      description="Its attempts, error, and payload appear here."
    />
  );
}
