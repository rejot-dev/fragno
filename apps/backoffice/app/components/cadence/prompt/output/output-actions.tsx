/*
 * Output actions — the thin seam between an output block and the surrounding
 * session. A block (e.g. the workflow preview card) may want to *do* something
 * beyond render itself — chiefly: open its graph in the build playground. Rather
 * than thread callbacks through the renderer registry (which keeps every block's
 * signature uniformly `{ block }`), blocks reach for these actions via context.
 *
 * `PromptProvider` supplies the real implementation; the stream surface wraps
 * the rendered blocks in the provider. Kept separate from `prompt-context` so
 * the output components stay decoupled from the prompt session and remain
 * trivially testable in isolation.
 */

import { createContext, useContext } from "react";

import type { WorkflowGraph } from "./output-model";

export type OutputActions = {
  /** Open a workflow graph in the build-mode playground. */
  openBuild: (args: { graph: WorkflowGraph; title?: string; sourceBlockId?: string }) => void;
};

const noopActions: OutputActions = {
  openBuild: () => {},
};

const OutputActionsContext = createContext<OutputActions>(noopActions);

export function OutputActionsProvider({
  actions,
  children,
}: {
  actions: OutputActions;
  children: React.ReactNode;
}) {
  return <OutputActionsContext.Provider value={actions}>{children}</OutputActionsContext.Provider>;
}

export function useOutputActions(): OutputActions {
  return useContext(OutputActionsContext);
}
