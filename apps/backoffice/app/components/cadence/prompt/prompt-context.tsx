/*
 * Prompt context — the shared brain behind the prompt surface.
 *
 * The prompt is split into two stacked pieces that need to share state: the
 * large execution-output block on top (`<PromptOutput>`) and the input surface
 * pinned at the bottom (`<Prompt>`). Because they're siblings in the page layout
 * rather than parent/child, everything they both touch lives here:
 *
 *   - `mode` — `compose` (plain-language) or `dev` (a real bash terminal).
 *   - the dev terminal session (`useDashboardTerminal` + its fetchers), so the
 *     output block can render the transcript while the input drives it.
 *   - `compose` — the compose session: status, the conducted prompt, and the Pi
 *     agent `session` it's bound to. The first prompt spins up a session; later
 *     prompts are follow-ups to that same session. The output block subscribes to
 *     it to render the live transcript.
 *
 * Leaving dev mode (Escape, or the toggle) hands focus back to the compose
 * input. Because the composer only mounts in compose mode, we record a one-shot
 * "focus on return" flag that the composer consumes when it mounts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { useFetcher } from "react-router";

import type { WorkflowGraph as CodemodeWorkflowGraph } from "@fragno-dev/workflow-visualizer";

import type { PiCollectionSource } from "@/fragno/pi/tanstack/browser-database";
import {
  type DashboardCommandResult,
  type DashboardPathAutocompleteRequest,
  type DashboardTerminalActionResult,
  useDashboardTerminal,
} from "@/routes/backoffice/dashboard-terminal";
import { PI_TERMINAL_COMMAND_SPECS } from "@/routes/backoffice/pi-terminal-specs";
import type { ComposeActionResult, ComposeSessionRef } from "@/routes/cadence/compose-action";

import type { OutputActions } from "./output/output-actions";
import type { ComposeBlock, WorkflowGraph } from "./output/output-model";

export type PromptMode = "compose" | "dev";

/** Which compose output surface is showing: the stream, or the build playground. */
export type ComposeView =
  | { kind: "stream" }
  | { kind: "build"; graph: WorkflowGraph; title?: string; sourceBlockId?: string };

/**
 * The companion workspace shown beside the conversation. It is not an either/or
 * with the transcript (unlike {@link ComposeView}) — it sits next to it in a
 * split, opened when the agent surfaces a workflow and dismissed by the user.
 */
export type ComposeWorkspace =
  | { kind: "none" }
  | { kind: "workflow"; name: string; mode: "view" | "edit" }
  // Workflows the agent ran via codemode (`execCodeMode`). They have no file on
  // disk, so the panel renders the parsed graph + source the tool returned directly,
  // plus the run output. Each `execCodeMode` call becomes its own tab.
  | { kind: "codemode"; entries: CodemodeEntry[]; activeIndex: number };

/** One codemode run shown as a tab in the companion panel (keyed by tool-call id). */
export type CodemodeEntry = {
  id: string;
  graph: CodemodeWorkflowGraph;
  code: string;
  title: string;
  output?: string;
  /**
   * Whether the run actually defined a workflow (vs. a plain script that just
   * computed a value). Only a workflow has a graph + durable run worth showing in
   * the workbench; a plain script renders as read-only code beside its output.
   */
  isWorkflow: boolean;
  /**
   * The durable run the agent scheduled for this code, when one was created. The
   * panel subscribes to it for realtime progress (step highlighting + emissions).
   */
  run?: { workflowName: string; instanceId: string };
};

/**
 * A past session shown in the exec history menu. It is a trimmed {@link PiSession}
 * (loaded by the exec route) — enough to label the row and, on click, rebuild the
 * {@link ComposeSessionRef} the transcript subscribes to.
 */
export type ComposeHistorySession = {
  id: string;
  name: string | null;
  status: string;
  workflowName: string;
  agentName: string;
  updatedAt: string | Date;
};

/** The compose session: everything the output block needs to render a result. */
export type ComposeSession = {
  status: "idle" | "composing" | "ready" | "error";
  /** The prompt that produced (or is producing) the current result. */
  prompt: string | null;
  /** The Pi agent session this prompt started (null until it's created). */
  session: ComposeSessionRef | null;
  /** The typed output stream. */
  blocks: ComposeBlock[];
  /** The active output surface. */
  view: ComposeView;
  /** The companion workflow panel shown beside the conversation, if any. */
  workspace: ComposeWorkspace;
  error: string | null;
};

/** The live dev terminal session, as produced by `useDashboardTerminal`. */
export type DevTerminal = ReturnType<typeof useDashboardTerminal>;

/** A single transcript row, as produced by `useDashboardTerminal`. */
export type DevTerminalEntry = DevTerminal["terminalHistory"][number];

type PromptContextValue = {
  mode: PromptMode;
  /** Switch to the dev terminal (typing a leading `/`, or the toggle). */
  enterDev: () => void;
  /** Return to compose mode, focusing the compose input on the way back. */
  exitDev: () => void;
  /** Read (and clear) the one-shot flag asking the composer to focus on mount. */
  consumeComposeFocus: () => boolean;
  /** Read (and clear) the one-shot flag asking the dev input to focus on mount. */
  consumeDevFocus: () => boolean;
  /** The active org's id used by the terminal and companion workflow panels. */
  organizationId?: string | null;
  /** The active org's name, for greetings and labels. */
  organizationName?: string | null;
  /** The scoped Pi source used to isolate and synchronize transcript collections. */
  piCollectionSource?: PiCollectionSource | null;
  /** The live dev terminal session (history, autocomplete, cwd, key handlers). */
  terminal: DevTerminal;
  /** Fetcher whose `Form` the dev input submits commands through. */
  commandFetcher: ReturnType<typeof useFetcher<DashboardTerminalActionResult>>;
  /** True while a dev command is in flight. */
  isSubmitting: boolean;
  /** The compose session (status, prompt, output blocks, active view). */
  compose: ComposeSession;
  /** Past sessions for this org, newest first, shown in the history menu. */
  history: ComposeHistorySession[];
  /** The id of the session currently bound to the surface, if any. */
  activeSessionId: string | null;
  /** Reopen a past session: bind it to the surface so the transcript renders it and follow-ups continue it. */
  resumeSession: (session: ComposeHistorySession) => void;
  /** Clear the surface back to an empty composer, ready to start a fresh session. */
  startNewSession: () => void;
  /** Conduct a compose draft: start a session (or follow up on the current one) and render the transcript. */
  conduct: (text: string) => void;
  /** Block-level output actions (e.g. opening a workflow in the build playground). */
  outputActions: OutputActions;
  /** Leave the build playground, returning to the stream. */
  closeBuild: () => void;
  /** Persist the playground's latest graph back into the build view. */
  updateBuildGraph: (graph: WorkflowGraph) => void;
  /** Open the companion workflow panel beside the conversation. */
  openWorkflow: (name: string, mode?: "view" | "edit") => void;
  /** Add a codemode run (parsed from `execCodeMode`) as a tab in the companion panel. */
  openCodemode: (entry: CodemodeEntry) => void;
  /** Switch the active codemode tab in the companion panel. */
  selectCodemodeTab: (index: number) => void;
  /** Dismiss the companion workflow panel, returning to a full-width chat. */
  closeWorkflow: () => void;
  /** Bumps whenever the agent writes a workflow, so the panel re-reads from disk. */
  workflowRefreshToken: number;
  /** Ask the open workflow panel to reload its source (after an agent edit). */
  refreshWorkflow: () => void;
};

const IDLE_COMPOSE: ComposeSession = {
  status: "idle",
  prompt: null,
  session: null,
  blocks: [],
  view: { kind: "stream" },
  workspace: { kind: "none" },
  error: null,
};

const PromptContext = createContext<PromptContextValue | null>(null);

export function PromptProvider({
  organizationId,
  organizationName,
  piCollectionSource,
  history = [],
  onConduct,
  children,
}: {
  organizationId?: string | null;
  organizationName?: string | null;
  piCollectionSource?: PiCollectionSource | null;
  /** Past sessions for the active org (loaded by the route), newest first. */
  history?: ComposeHistorySession[];
  onConduct?: (text: string) => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<PromptMode>("compose");
  const [compose, setCompose] = useState<ComposeSession>(IDLE_COMPOSE);
  const [workflowRefreshToken, setWorkflowRefreshToken] = useState(0);
  const focusComposeRef = useRef(false);
  const focusDevRef = useRef(false);

  const commandFetcher = useFetcher<DashboardTerminalActionResult>();
  const pathAutocompleteFetcher = useFetcher<DashboardTerminalActionResult>();
  const composeFetcher = useFetcher<ComposeActionResult>();

  const isSubmitting = commandFetcher.state !== "idle";
  const commandResult: DashboardCommandResult | undefined =
    commandFetcher.data?.intent === "run-command" ? commandFetcher.data : undefined;
  const pathAutocompleteResult =
    pathAutocompleteFetcher.data?.intent === "autocomplete-path"
      ? pathAutocompleteFetcher.data
      : undefined;

  const requestPathAutocomplete = useCallback(
    (request: DashboardPathAutocompleteRequest) => {
      const formData = new FormData();
      formData.set("intent", request.intent);
      formData.set("commandLine", request.commandLine);
      formData.set("cwd", request.cwd);
      formData.set("cursorPosition", String(request.cursorPosition));
      void pathAutocompleteFetcher.submit(formData, { method: "post" });
    },
    [pathAutocompleteFetcher],
  );

  const terminal = useDashboardTerminal({
    scopeId: organizationId,
    scopeName: organizationName,
    result: commandResult,
    pathAutocompleteResult,
    requestPathAutocomplete,
    disabled: isSubmitting,
    commandSpecs: PI_TERMINAL_COMMAND_SPECS,
  });

  const enterDev = useCallback(() => {
    focusDevRef.current = true;
    setMode("dev");
  }, []);

  const exitDev = useCallback(() => {
    focusComposeRef.current = true;
    setMode("compose");
  }, []);

  const consumeComposeFocus = useCallback(() => {
    const shouldFocus = focusComposeRef.current;
    focusComposeRef.current = false;
    return shouldFocus;
  }, []);

  const consumeDevFocus = useCallback(() => {
    const shouldFocus = focusDevRef.current;
    focusDevRef.current = false;
    return shouldFocus;
  }, []);

  const conduct = useCallback(
    (text: string) => {
      // The first prompt starts a session; every prompt after it is a follow-up
      // to that same session, so we keep the current ref and forward it to the
      // action. Optimistically reflect the in-flight prompt; the (un)changed
      // session ref lands via the fetcher effect below.
      const existingSession = compose.session;
      setCompose((current) => ({
        status: "composing",
        prompt: text,
        session: existingSession,
        blocks: [],
        view: { kind: "stream" },
        // Keep the companion panel open across follow-up prompts.
        workspace: current.workspace,
        error: null,
      }));

      const formData = new FormData();
      formData.set("intent", "compose");
      formData.set("prompt", text);
      if (existingSession) {
        formData.set("sessionId", existingSession.id);
        formData.set("workflowName", existingSession.workflowName);
        formData.set("agentName", existingSession.agentName);
      }
      void composeFetcher.submit(formData, { method: "post" });

      onConduct?.(text);
    },
    [compose.session, composeFetcher, onConduct],
  );

  // Fold the started session into the compose state once it lands. The output
  // block then subscribes to its persisted collections to render the live transcript.
  const composeData = composeFetcher.data;
  useEffect(() => {
    if (composeData?.intent !== "compose") {
      return;
    }
    if (composeData.ok) {
      setCompose((current) => ({
        status: "ready",
        prompt: current.prompt,
        session: composeData.session,
        blocks: [],
        view: { kind: "stream" },
        workspace: current.workspace,
        error: null,
      }));
    } else {
      setCompose((current) => ({
        ...current,
        status: "error",
        error: composeData.error,
      }));
    }
  }, [composeData]);

  const openBuild = useCallback<OutputActions["openBuild"]>(({ graph, title, sourceBlockId }) => {
    setCompose((current) => ({
      ...current,
      view: { kind: "build", graph, title, sourceBlockId },
    }));
  }, []);

  const closeBuild = useCallback(() => {
    setCompose((current) =>
      current.view.kind === "build" ? { ...current, view: { kind: "stream" } } : current,
    );
  }, []);

  // Keep the build view's graph in sync with the playground's edits, so leaving
  // and reopening build preserves them.
  const updateBuildGraph = useCallback((graph: WorkflowGraph) => {
    setCompose((current) =>
      current.view.kind === "build" ? { ...current, view: { ...current.view, graph } } : current,
    );
  }, []);

  const openWorkflow = useCallback((name: string, mode: "view" | "edit" = "view") => {
    setCompose((current) => ({ ...current, workspace: { kind: "workflow", name, mode } }));
  }, []);

  const openCodemode = useCallback((entry: CodemodeEntry) => {
    setCompose((current) => {
      const existing = current.workspace.kind === "codemode" ? current.workspace.entries : [];
      const at = existing.findIndex((e) => e.id === entry.id);
      // Re-running the same tool call updates its tab in place; a new call appends.
      const entries =
        at >= 0 ? existing.map((e, i) => (i === at ? entry : e)) : [...existing, entry];
      return {
        ...current,
        workspace: { kind: "codemode", entries, activeIndex: at >= 0 ? at : entries.length - 1 },
      };
    });
  }, []);

  const selectCodemodeTab = useCallback((index: number) => {
    setCompose((current) =>
      current.workspace.kind === "codemode"
        ? { ...current, workspace: { ...current.workspace, activeIndex: index } }
        : current,
    );
  }, []);

  const closeWorkflow = useCallback(() => {
    setCompose((current) => ({ ...current, workspace: { kind: "none" } }));
  }, []);

  const refreshWorkflow = useCallback(() => {
    setWorkflowRefreshToken((token) => token + 1);
  }, []);

  // Reopen a past session: bind it to the surface as a ready session. The output
  // block then renders <ComposeTranscript> for it (loading its persisted history),
  // and the next prompt continues it as a follow-up. Any companion panel
  // from the previous session is dismissed, since it belonged to that conversation.
  const resumeSession = useCallback((session: ComposeHistorySession) => {
    setCompose({
      status: "ready",
      prompt: null,
      session: {
        id: session.id,
        workflowName: session.workflowName,
        agentName: session.agentName,
      },
      blocks: [],
      view: { kind: "stream" },
      workspace: { kind: "none" },
      error: null,
    });
  }, []);

  // Drop back to an empty composer so the next prompt starts a fresh session.
  const startNewSession = useCallback(() => {
    setCompose(IDLE_COMPOSE);
  }, []);

  const outputActions = useMemo<OutputActions>(() => ({ openBuild }), [openBuild]);

  const value = useMemo(
    () => ({
      mode,
      enterDev,
      exitDev,
      consumeComposeFocus,
      consumeDevFocus,
      organizationId,
      organizationName,
      piCollectionSource,
      terminal,
      commandFetcher,
      isSubmitting,
      compose,
      history,
      activeSessionId: compose.session?.id ?? null,
      resumeSession,
      startNewSession,
      conduct,
      outputActions,
      closeBuild,
      updateBuildGraph,
      openWorkflow,
      openCodemode,
      selectCodemodeTab,
      closeWorkflow,
      workflowRefreshToken,
      refreshWorkflow,
    }),
    [
      mode,
      enterDev,
      exitDev,
      consumeComposeFocus,
      consumeDevFocus,
      organizationId,
      organizationName,
      piCollectionSource,
      terminal,
      commandFetcher,
      isSubmitting,
      compose,
      history,
      resumeSession,
      startNewSession,
      conduct,
      outputActions,
      closeBuild,
      updateBuildGraph,
      openWorkflow,
      openCodemode,
      selectCodemodeTab,
      closeWorkflow,
      workflowRefreshToken,
      refreshWorkflow,
    ],
  );

  return <PromptContext.Provider value={value}>{children}</PromptContext.Provider>;
}

export function usePrompt(): PromptContextValue {
  const context = useContext(PromptContext);
  if (!context) {
    throw new Error("usePrompt must be used within a <PromptProvider>.");
  }
  return context;
}
