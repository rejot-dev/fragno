/*
 * Compose transcript — renders the live Pi session a prompt started. Each prompt
 * gets its own session (see `compose-action`), so this subscribes to exactly that
 * session via the Pi client and renders the conversation as it streams in.
 *
 * It deliberately stays lightweight compared to the full backoffice session view:
 * the exec surface only needs the back-and-forth (the user's prompt and the
 * agent's reply), plus a compact note for tool activity and a working indicator.
 */

import { AlertTriangle, ChevronRight, Sparkles, Workflow, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { WorkflowGraph as CodemodeWorkflowGraph } from "@fragno-dev/workflow-visualizer";

import { createPiClient } from "@/fragno/pi/pi-client";
import type { ComposeSessionRef } from "@/routes/cadence/compose-action";

/** The live durable run an `execCodeMode` result scheduled, for realtime progress. */
type CodemodeRunHandle = { workflowName: string; instanceId: string };

/** The codemode run an `execCodeMode` result carries, for opening the panel. */
type CodemodeRowEntry = {
  id: string;
  graph: CodemodeWorkflowGraph;
  code: string;
  title: string;
  output?: string;
  /** The scheduled durable run, when one was created — drives live highlighting. */
  run?: CodemodeRunHandle;
};

type TranscriptRow =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "toolOutput"; key: string; name: string; text: string; isError: boolean }
  // A clickable `execCodeMode` result that (re)opens the companion panel at its tab.
  | { kind: "codemode"; key: string; entry: CodemodeRowEntry }
  | { kind: "error"; key: string; text: string };

/** Pull human-readable text out of a message's content, whatever its shape. */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Names of the tool calls an assistant message issued (for the activity rows). */
function extractToolNames(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part): part is { type: string; name?: unknown } =>
      Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"),
    )
    .map((part) => (typeof part.name === "string" ? part.name : "tool"));
}

/**
 * Build the codemode panel entry from an `execCodeMode` tool result, or null when
 * it carries no parsed workflow (e.g. it failed before producing one). The entry
 * id is the tool-call id, so the same run always maps to the same panel tab.
 */
function codemodeEntryFromResult(
  message: { toolCallId?: unknown; details?: unknown },
  index: number,
): CodemodeRowEntry | null {
  const details = message.details as
    | {
        code?: unknown;
        workflowGraph?: unknown;
        outputText?: unknown;
        workflowDefinition?: { name?: unknown };
        run?: { workflowName?: unknown; instanceId?: unknown };
      }
    | undefined;
  const graph = details?.workflowGraph as CodemodeWorkflowGraph | undefined;
  const code = typeof details?.code === "string" ? details.code : undefined;
  if (!graph || !code) {
    return null;
  }
  // The scheduled run handle, present only when the durable run was created.
  const run =
    typeof details?.run?.workflowName === "string" && typeof details?.run?.instanceId === "string"
      ? { workflowName: details.run.workflowName, instanceId: details.run.instanceId }
      : undefined;
  return {
    id: typeof message.toolCallId === "string" ? message.toolCallId : `codemode-${index}`,
    graph,
    code,
    title:
      typeof details?.workflowDefinition?.name === "string"
        ? details.workflowDefinition.name
        : "Codemode workflow",
    output: typeof details?.outputText === "string" ? details.outputText : undefined,
    run,
  };
}

/** Flatten the agent's message list into a renderable, text-only transcript. */
function toRows(
  messages: readonly {
    role?: string;
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    toolName?: unknown;
    isError?: unknown;
    toolCallId?: unknown;
    details?: unknown;
  }[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  messages.forEach((message, index) => {
    const role = message.role;
    if (role === "user") {
      const text = extractText(message.content).trim();
      if (text) {
        rows.push({ kind: "user", key: `user-${index}`, text });
      }
      return;
    }
    // A tool's result — render its actual output, not just the call name, so the
    // output view shows what each tool produced (codemode logs, command output…).
    if (role === "toolResult") {
      // A codemode run with a parsed workflow becomes a clickable row that opens
      // the companion panel at its tab (keyed by tool-call id, so it re-selects
      // rather than duplicates). Falls through to plain output when it didn't parse.
      if (message.toolName === "execCodeMode") {
        const entry = codemodeEntryFromResult(message, index);
        if (entry) {
          rows.push({ kind: "codemode", key: `codemode-${index}`, entry });
          return;
        }
      }
      const text = extractText(message.content).trim();
      if (text) {
        rows.push({
          kind: "toolOutput",
          key: `toolOutput-${index}`,
          name: typeof message.toolName === "string" ? message.toolName : "tool",
          text,
          isError: message.isError === true,
        });
      }
      return;
    }
    if (role === "assistant") {
      const text = extractText(message.content).trim();
      if (text) {
        rows.push({ kind: "assistant", key: `assistant-${index}`, text });
      }
      // The tool *calls* aren't rendered on their own — each tool's `toolResult`
      // already produces a row showing the name plus its output, so emitting a
      // call row too would list every tool twice. We still count the calls to
      // distinguish a no-text tool turn from a genuinely empty (errored) one.
      const tools = extractToolNames(message.content);

      // An errored turn often comes back with no text and no tool calls (e.g. a
      // provider "Connection error."). Surface it so the output never goes blank.
      const errorMessage =
        typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
      if (!text && tools.length === 0 && (errorMessage || message.stopReason === "error")) {
        rows.push({
          kind: "error",
          key: `error-${index}`,
          text: errorMessage || "The agent stopped with an error.",
        });
      }
    }
  });
  return rows;
}

export function ComposeTranscript({
  orgId,
  session,
  prompt,
  onShowWorkflow,
  onShowCodemode,
  onWorkflowWritten,
}: {
  orgId: string;
  session: ComposeSessionRef;
  prompt?: string;
  /** Called when the agent issues a `showWorkflow` tool call (name + mode). */
  onShowWorkflow?: (name: string, mode?: "view" | "edit") => void;
  /** Called when an `execCodeMode` tool result lands — adds a tab for the run. */
  onShowCodemode?: (entry: CodemodeRowEntry) => void;
  /** Called when a `writeAutomation` tool result lands, so the panel reloads. */
  onWorkflowWritten?: () => void;
}) {
  const pi = useMemo(() => createPiClient(orgId), [orgId]);
  const live = pi.useSession({
    path: { workflowName: session.workflowName, sessionId: session.id },
  });

  const rows = useMemo(() => toRows(live.messages), [live.messages]);

  // React to the agent's workflow tool *results* (not calls — calls stream in
  // before the tool runs, with raw/partial args):
  //   - `showWorkflow` → open the companion panel at the resolved canonical name
  //     and mode the tool returns (so a name *or* file path both work).
  //   - `writeAutomation` → reload the panel so the agent's edit shows up live.
  // Processed tool-call ids are tracked so re-renders don't re-fire a handled one.
  const handledToolResults = useRef<Set<string>>(new Set());
  useEffect(() => {
    live.messages.forEach((message, index) => {
      const result = message as {
        role?: string;
        toolName?: unknown;
        toolCallId?: unknown;
        isError?: unknown;
        details?: unknown;
      };
      if (result.role !== "toolResult" || result.isError === true) {
        return;
      }
      const key = typeof result.toolCallId === "string" ? result.toolCallId : `idx-${index}`;
      if (handledToolResults.current.has(key)) {
        return;
      }

      if (result.toolName === "showWorkflow" && onShowWorkflow) {
        const details = result.details as { workflow?: unknown; mode?: unknown; found?: unknown };
        const workflow = typeof details?.workflow === "string" ? details.workflow : undefined;
        if (workflow && details?.found !== false) {
          handledToolResults.current.add(key);
          onShowWorkflow(workflow, details?.mode === "edit" ? "edit" : "view");
        }
        return;
      }

      // Codemode always runs a workflow; the tool attaches its parsed graph + the
      // source it ran, so open the companion viewer on the result the first time.
      if (result.toolName === "execCodeMode" && onShowCodemode) {
        const entry = codemodeEntryFromResult(result, index);
        if (entry) {
          handledToolResults.current.add(key);
          onShowCodemode(entry);
        }
        return;
      }

      if (result.toolName === "writeAutomation") {
        handledToolResults.current.add(key);
        onWorkflowWritten?.();
      }
    });
  }, [live.messages, onShowWorkflow, onShowCodemode, onWorkflowWritten]);
  // Until the first message round-trips, fall back to echoing the prompt so the
  // surface never looks empty while the session spins up.
  const hasUserRow = rows.some((row) => row.kind === "user");

  // Stick to the bottom as the session streams in, so the latest output stays
  // visible — but only while the user is already near the bottom, so scrolling
  // up to read earlier output isn't fought on every token. We track "pinned"
  // from scroll events (i.e. *before* new content grows the node); measuring
  // after the update would break stickiness when a big chunk arrives at once.
  //
  // We re-pin from a ResizeObserver rather than the row list, because Streamdown
  // renders its markdown asynchronously: the content keeps growing after React
  // commits, and on remount (e.g. flipping dev → compose) the final height isn't
  // known when the effect first runs. Observing the content covers both.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  useEffect(() => {
    const node = scrollRef.current;
    const content = contentRef.current;
    if (!node || !content) {
      return;
    }
    const stickToBottom = () => {
      if (pinnedRef.current) {
        node.scrollTop = node.scrollHeight;
      }
    };
    stickToBottom();
    const observer = new ResizeObserver(stickToBottom);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="cad-scroll min-h-0 flex-1 overflow-auto px-5 py-5"
    >
      <div ref={contentRef}>
        {prompt && !hasUserRow ? (
          <p className="mb-4 flex items-start gap-2 text-xs text-[var(--cad-muted)]">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cad-brass)]" />
            <span className="italic">“{prompt}”</span>
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          {rows.map((row) => {
            if (row.kind === "user") {
              return (
                <p key={row.key} className="flex items-start gap-2 text-xs text-[var(--cad-muted)]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--cad-brass)]" />
                  <span className="italic">“{row.text}”</span>
                </p>
              );
            }
            if (row.kind === "toolOutput") {
              return (
                <ToolOutputRow
                  key={row.key}
                  name={row.name}
                  text={row.text}
                  isError={row.isError}
                />
              );
            }
            if (row.kind === "codemode") {
              return (
                <div key={row.key} className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => onShowCodemode?.(row.entry)}
                    title="Open in the workflow panel"
                    className="group flex items-center gap-1.5 text-left text-xs text-[var(--cad-muted-2)] hover:text-[var(--cad-fg)]"
                  >
                    <Workflow className="h-3 w-3 shrink-0 text-[var(--cad-brass)]" />
                    <span className="font-mono">execCodeMode</span>
                    <span className="truncate text-[var(--cad-muted)]">· {row.entry.title}</span>
                    <span className="text-[var(--cad-brass-strong)] opacity-0 transition-opacity group-hover:opacity-100">
                      open ↗
                    </span>
                  </button>
                  {/* The durable run finishes after the tool returns, so its final
                      output is forwarded here once it lands. */}
                  {row.entry.run ? <CodemodeRunOutput orgId={orgId} run={row.entry.run} /> : null}
                </div>
              );
            }
            if (row.kind === "error") {
              return (
                <p
                  key={row.key}
                  className="flex items-start gap-2 rounded-lg border border-[color:var(--cad-rose)]/30 bg-[var(--cad-rose)]/5 px-3 py-2 text-xs text-[var(--cad-rose)]"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{row.text}</span>
                </p>
              );
            }
            return (
              <div key={row.key} className="cad-prose text-xs leading-relaxed text-[var(--cad-fg)]">
                <Streamdown>{row.text}</Streamdown>
              </div>
            );
          })}
        </div>

        {live.error ? (
          <p className="mt-4 text-xs text-[var(--cad-rose)]">{live.error}</p>
        ) : !live.readyForInput ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-[var(--cad-muted-2)]">
            <span className="cad-pulse inline-block h-2 w-2 rounded-full bg-[var(--cad-brass)]" />
            {live.statusText || "Working…"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const RUN_TERMINAL = new Set(["complete", "errored", "terminated"]);
const RUN_OUTPUT_POLL_MS = 1000;

/**
 * Track a codemode run's durable instance and surface its final output once the
 * run completes. The `execCodeMode` tool returns a run *handle* before the
 * workflow finishes, so the real output only becomes available later — this
 * polls the instance status endpoint (the same one the workflow panel uses)
 * until the run reaches a terminal state, then forwards the output here.
 */
function useCodemodeRunOutput(
  orgId: string,
  run?: { workflowName: string; instanceId: string },
): { status: string; output: unknown; hasOutput: boolean } {
  const [state, setState] = useState<{ status: string; output: unknown; hasOutput: boolean }>({
    status: "idle",
    output: undefined,
    hasOutput: false,
  });

  const workflowName = run?.workflowName;
  const instanceId = run?.instanceId;

  useEffect(() => {
    if (!workflowName || !instanceId) {
      return;
    }
    const controller = new AbortController();
    const base = `/api/automations-workflows/${encodeURIComponent(orgId)}/${encodeURIComponent(
      workflowName,
    )}/instances/${encodeURIComponent(instanceId)}`;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const poll = async () => {
      try {
        const res = await fetch(base, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          return;
        }
        const body = (await res.json()) as {
          details?: { status?: string; output?: unknown };
        };
        const status = body.details?.status ?? "active";
        const hasOutput = Boolean(body.details && "output" in body.details);
        setState({ status, output: body.details?.output, hasOutput });
        if (RUN_TERMINAL.has(status)) {
          stop();
        }
      } catch {
        // Transient poll failures are non-fatal; the next tick retries.
      }
    };

    void poll();
    timer = setInterval(() => void poll(), RUN_OUTPUT_POLL_MS);

    return () => {
      stop();
      controller.abort();
    };
  }, [orgId, workflowName, instanceId]);

  return state;
}

/** Render a workflow output value as readable text, parsing JSON-encoded strings. */
function parseWorkflowOutput(output: unknown): string {
  if (output === undefined) {
    return "";
  }
  if (output === null) {
    return "null";
  }
  if (typeof output === "string") {
    // The code may return a JSON string — parse it so it shows structured rather
    // than as an escaped one-liner. Plain strings pass through unchanged.
    const trimmed = output.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return output;
      }
    }
    return output;
  }
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

/**
 * The codemode run's final output, forwarded into the main transcript once the
 * durable workflow completes. Stays hidden until an output (or error) lands, so
 * a still-running workflow adds no noise.
 */
function CodemodeRunOutput({
  orgId,
  run,
}: {
  orgId: string;
  run: { workflowName: string; instanceId: string };
}) {
  const { status, output, hasOutput } = useCodemodeRunOutput(orgId, run);
  const errored = status === "errored";
  // Show once the run produced an output, or when it errored (to surface why).
  const ready = (hasOutput && output !== undefined && output !== null) || errored;
  if (!ready) {
    return null;
  }
  const text = parseWorkflowOutput(output);
  if (!text && !errored) {
    return null;
  }

  return (
    <div className="ml-4 flex flex-col gap-1">
      <span className="cad-eyebrow text-[var(--cad-muted-2)]">workflow output</span>
      <pre
        className={`cad-scroll cad-mono max-h-80 overflow-auto rounded-lg border px-2.5 py-1.5 text-[11px] leading-relaxed break-words whitespace-pre-wrap ${
          errored
            ? "border-[color:var(--cad-rose)]/30 bg-[var(--cad-rose)]/5 text-[var(--cad-rose)]"
            : "border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] text-[var(--cad-muted)]"
        }`}
      >
        {text || "No output."}
      </pre>
    </div>
  );
}

/**
 * One tool result: a clickable name row that, by default, shows nothing more.
 * Clicking it reveals the actual output the tool returned in a monospace,
 * scroll-capped block so it never floods the transcript.
 */
function ToolOutputRow({ name, text, isError }: { name: string; text: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-left text-xs text-[var(--cad-muted-2)] hover:text-[var(--cad-fg)]"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 text-[var(--cad-brass)] transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <Wrench className="h-3 w-3 shrink-0 text-[var(--cad-brass)]" />
        <span className="font-mono">{name}</span>
        {isError ? <span className="text-[var(--cad-rose)]">· error</span> : null}
      </button>
      {expanded ? (
        <pre
          className={`cad-scroll cad-mono ml-4 max-h-80 overflow-auto rounded-lg border px-2.5 py-1.5 text-[11px] leading-relaxed break-words whitespace-pre-wrap ${
            isError
              ? "border-[color:var(--cad-rose)]/30 bg-[var(--cad-rose)]/5 text-[var(--cad-rose)]"
              : "border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] text-[var(--cad-muted)]"
          }`}
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}
