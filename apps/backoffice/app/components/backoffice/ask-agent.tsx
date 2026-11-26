import { createContext, useContext } from "react";

/**
 * What a page last asked of the agent drawer: to show an agent and, when the page asks it
 * something, a message for its composer to hold unsent. `id` tells one request from the next, so
 * asking the same thing twice fills the composer again.
 */
export type AgentRequest = {
  id: number;
  agentsPath: string;
  agentName: string;
  text: string | null;
};

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

/**
 * Phones wide enough to keep the agent beside the page, such as an unfolded iPhone Duo on its
 * side: the phone chrome (the opposite of the `desktop` variant in app.css) from 768px wide. On
 * them, a conversation shows only in the drawer.
 */
export const AGENT_BESIDE_PHONE_QUERY =
  "(pointer: coarse) and (width >= 768px) and (height < 660px)";

/** Opens the agent drawer on `agentName`. */
type ShowAgentBeside = (agentName: string) => void;

export const ShowAgentBesideContext = createContext<ShowAgentBeside | null>(null);

/**
 * How the agents pages hand an agent's conversation to the drawer on phones that keep it beside
 * the page, where a conversation shows only in the drawer; null where conversations show in the
 * page.
 */
export function useShowAgentBeside(): ShowAgentBeside | null {
  return useContext(ShowAgentBesideContext);
}
