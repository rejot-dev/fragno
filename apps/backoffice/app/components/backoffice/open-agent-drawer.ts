import { createContext, useContext } from "react";

/** Opens the agent drawer beside the page, for a page that just started a conversation in it. */
export const OpenAgentDrawerContext = createContext<(() => void) | null>(null);

export function useOpenAgentDrawer(): () => void {
  const open = useContext(OpenAgentDrawerContext);
  if (!open) {
    throw new Error("useOpenAgentDrawer must be used inside the Backoffice shell.");
  }
  return open;
}
