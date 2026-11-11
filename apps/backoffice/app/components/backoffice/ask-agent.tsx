import { createContext, useContext } from "react";

/**
 * A message waiting in an agent's composer for the person to edit and send. `id` tells one request
 * from the next, so asking the same thing twice fills the composer again.
 */
export type AgentDraft = { id: number; agentsPath: string; agentName: string; text: string };

/**
 * A draft for a composer to fill once. The composer reports it filled, so a conversation that
 * mounts again, such as after switching agents and back, does not put it back.
 */
export type ComposerDraft = { text: string; onFilled: () => void };

/** Opens the agent drawer on `agentName` with `text` in its composer, unsent. */
type AskAgent = (request: { agentName: string; text: string }) => void;

export const AskAgentContext = createContext<AskAgent | null>(null);

/** How a page asks an agent about what it shows; null outside the shell, where no drawer opens. */
export function useAskAgent(): AskAgent | null {
  return useContext(AskAgentContext);
}
