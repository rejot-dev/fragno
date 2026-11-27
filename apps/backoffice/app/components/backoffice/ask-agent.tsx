import { createContext, useContext } from "react";

/** The agent a page last asked the drawer to show; `id` tells one request from the next. */
export type AgentRequest = { id: number; agentsPath: string; agentName: string };

/**
 * A message waiting in an agent's composer for the person to edit and send. Apart from the request
 * that shows the agent, so showing it again, as its profile does, keeps the message waiting. `id`
 * tells one draft from the next, so asking the same thing twice fills the composer again.
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

/**
 * Phones wide enough to keep the agent beside the page, such as an unfolded iPhone Duo on its
 * side: the phone chrome (the opposite of the `desktop` variant in app.css) from 768px wide. On
 * them, a conversation shows only in the drawer.
 */
export const AGENT_BESIDE_PHONE_QUERY =
  "(pointer: coarse) and (width >= 768px) and (not ((min-device-width: 744px) and (min-device-height: 744px)))";

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
