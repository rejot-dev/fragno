import { ScrollArea } from "@base-ui/react/scroll-area";
import { Switch } from "@base-ui/react/switch";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { Streamdown } from "streamdown";

import type { PiSessionEventStreamItem } from "@fragno-dev/pi-fragment";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type LiveToolExecution = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown | null;
};

export type LiveToolCallDraft = {
  key: string;
  contentIndex: number;
  toolCallId: string | null;
  toolName: string | null;
  argumentsText: string;
  argumentsValue: unknown | null;
  status: "streaming" | "complete";
};

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

const formatMessageTimestamp = (timestamp?: number) => {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
};

const normalizeContent = (content: unknown): ContentBlock[] => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlock[];
  }
  if (content && typeof content === "object" && "type" in content) {
    return [content as ContentBlock];
  }
  return [];
};

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const getCodeArgument = (value: unknown) => {
  if (!isRecord(value) || typeof value.code !== "string") {
    return null;
  }

  const { code, ...rest } = value;
  return { code, rest };
};

const decodeStreamingJsonString = (value: string) => {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      break;
    }
    if (char !== "\\") {
      result += char;
      continue;
    }

    const escaped = value[++index];
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        result += escaped;
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "u": {
        const hex = value.slice(index + 1, index + 5);
        if (/^[\da-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        }
        break;
      }
      case undefined:
        return result;
      default:
        result += escaped;
    }
  }
  return result;
};

const extractStreamingJsonStringField = (rawText: string | undefined, fieldNames: string[]) => {
  if (!rawText) {
    return null;
  }

  for (const fieldName of fieldNames) {
    const fieldStart = rawText.indexOf(JSON.stringify(fieldName));
    if (fieldStart === -1) {
      continue;
    }

    const colon = rawText.indexOf(":", fieldStart + fieldName.length + 2);
    if (colon === -1) {
      continue;
    }

    let valueStart = colon + 1;
    while (/\s/.test(rawText[valueStart] ?? "")) {
      valueStart++;
    }
    if (rawText[valueStart] !== '"') {
      continue;
    }

    return decodeStreamingJsonString(rawText.slice(valueStart + 1));
  }

  return null;
};

export const formatToolArgumentsDisplayText = ({
  rawText,
  value,
}: {
  rawText?: string;
  value: unknown;
}) => {
  const codeArgument = getCodeArgument(value);
  const streamingCode = extractStreamingJsonStringField(rawText, ["code"]);
  if (streamingCode && streamingCode.length >= (codeArgument ? codeArgument.code.length : 0)) {
    return streamingCode;
  }
  if (codeArgument) {
    return codeArgument.code;
  }
  return rawText && rawText.length > 0 ? rawText : formatJson(value);
};

export function SessionHeader({
  backTo,
  harnessLabel,
  modelLabel,
  options,
  session,
}: {
  backTo: string;
  harnessLabel: string;
  modelLabel: string;
  options?: ReactNode;
  session: {
    id: string;
    name?: string | null;
    status: string;
    updatedAt: string | Date;
  };
}) {
  return (
    <div className="flex w-full flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          <Link
            to={backTo}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back
          </Link>
          <span className="h-3 w-px bg-[var(--bo-border-strong)]" />
          <span>Session detail</span>
        </div>
        <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
          {session.name || session.id}
        </h3>
        <div className="mt-2 grid gap-2 text-xs text-[var(--bo-muted-2)] sm:grid-cols-[1fr_auto] sm:items-start">
          <span>
            {harnessLabel} · {modelLabel}
          </span>
          {options}
        </div>
      </div>
    </div>
  );
}

export function SessionDisplayOptions({
  exportFilename,
  exportHref,
  showThinking,
  showToolCalls,
  showTrace,
  showUsage,
  onShowThinkingChange,
  onShowToolCallsChange,
  onShowTraceChange,
  onShowUsageChange,
}: {
  exportFilename: string;
  exportHref: string;
  showThinking: boolean;
  showToolCalls: boolean;
  showTrace: boolean;
  showUsage: boolean;
  onShowThinkingChange: (value: boolean) => void;
  onShowToolCallsChange: (value: boolean) => void;
  onShowTraceChange: (value: boolean) => void;
  onShowUsageChange: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-auto space-y-2 sm:min-w-96">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:text-[var(--bo-fg)]"
        >
          Options {expanded ? "−" : "+"}
        </button>
      </div>

      {expanded ? (
        <div className="ml-auto space-y-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-right">
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleSwitch
              label="Tool calls"
              checked={showToolCalls}
              onCheckedChange={onShowToolCallsChange}
            />
            <ToggleSwitch
              label="Thinking"
              checked={showThinking}
              onCheckedChange={onShowThinkingChange}
            />
            <ToggleSwitch label="Trace" checked={showTrace} onCheckedChange={onShowTraceChange} />
            <ToggleSwitch label="Usage" checked={showUsage} onCheckedChange={onShowUsageChange} />
          </div>
          <a
            href={exportHref}
            download={exportFilename}
            className="ml-auto inline-flex items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Download JSONL
          </a>
        </div>
      ) : null}
    </div>
  );
}

export function SessionConversationPanel({
  draftToolCalls,
  messages,
  onJumpToLatest,
  onScroll,
  readyForInput,
  runningTools,
  scrollContentRef,
  scrollViewportRef,
  showJumpToLatest,
  showThinking,
  showToolCalls,
  showUsage,
  statusText,
}: {
  draftToolCalls: LiveToolCallDraft[];
  messages: AgentMessage[];
  onJumpToLatest: () => void;
  onScroll: () => void;
  readyForInput: boolean;
  runningTools: LiveToolExecution[];
  scrollContentRef: RefObject<HTMLDivElement | null>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  showJumpToLatest: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  statusText: string | null;
}) {
  const lastMessage = messages.at(-1);
  const showPendingAssistant = !readyForInput && lastMessage?.role !== "assistant";
  const toolResultsByCallId = new Map<string, ToolResultMessage>();

  for (const message of messages) {
    if (message.role === "toolResult") {
      toolResultsByCallId.set(message.toolCallId, message);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
      <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
        <ScrollArea.Viewport
          ref={scrollViewportRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 p-3"
        >
          <ScrollArea.Content ref={scrollContentRef} className="space-y-3">
            {messages.length === 0 && !showPendingAssistant ? (
              <div className="text-sm text-[var(--bo-muted)]">No messages yet.</div>
            ) : (
              messages.map((message, index) => (
                <MessageCard
                  key={`${message.role}-${index}`}
                  draftToolCalls={message === lastMessage ? draftToolCalls : []}
                  message={message}
                  runningTools={runningTools}
                  showToolCalls={showToolCalls}
                  showThinking={showThinking}
                  showUsage={showUsage}
                  toolResultsByCallId={toolResultsByCallId}
                />
              ))
            )}

            {showPendingAssistant ? (
              <PendingAssistantCard
                draftToolCalls={draftToolCalls}
                runningTools={runningTools}
                showToolCalls={showToolCalls}
                statusText={statusText}
              />
            ) : null}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 p-[2px] select-none">
          <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
        </ScrollArea.Scrollbar>
        <ScrollArea.Corner className="bg-transparent" />

        {showJumpToLatest ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3">
            <button
              type="button"
              onClick={onJumpToLatest}
              className="pointer-events-auto border border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent)] uppercase shadow-[0_10px_24px_rgba(0,0,0,0.16)] transition-colors hover:border-[color:var(--bo-accent-strong)] hover:text-[var(--bo-accent-fg)]"
            >
              Jump to latest
            </button>
          </div>
        ) : null}
      </ScrollArea.Root>
    </div>
  );
}

export function SessionComposer({
  busy,
  error,
  needsNudge,
  onContinue,
  onSend,
  onStop,
  readyForInput,
}: {
  busy: boolean;
  readyForInput: boolean;
  disabledReason?: string | null;
  error: string | null;
  needsNudge: boolean;
  onContinue: () => Promise<unknown> | unknown;
  onSend: (command: { kind: "followUp" | "steer"; text: string }) => Promise<boolean> | boolean;
  onStop: () => Promise<unknown> | unknown;
}) {
  const [draftMessage, setDraftMessage] = useState("");
  const [mode, setMode] = useState<"followUp" | "steer">("followUp");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draftMessage]);

  const submitDraft = async () => {
    const didSend = await onSend({ kind: mode, text: draftMessage });
    if (didSend) {
      setDraftMessage("");
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitDraft();
      }}
      className="flex-none border border-t-0 border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-0"
    >
      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-colors duration-150 focus-within:border-[color:var(--bo-accent)] focus-within:ring-2 focus-within:ring-[color:var(--bo-accent)]/15">
        <textarea
          ref={textareaRef}
          name="text"
          rows={1}
          value={draftMessage}
          onChange={(event) => setDraftMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              submitDraft();
            }
          }}
          placeholder={
            mode === "steer" ? "Steer the running session…" : "Send a follow-up message…"
          }
          disabled={busy}
          className="block max-h-40 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-2 text-sm leading-7 text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:outline-none disabled:opacity-60"
        />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy || readyForInput}
              onClick={onStop}
              className="min-h-8 border border-red-400/40 bg-red-500/10 px-2.5 text-[10px] font-semibold tracking-[0.14em] text-red-500 uppercase transition-[border-color,background-color,transform,opacity] duration-150 hover:border-red-400 hover:bg-red-500/15 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
            >
              Stop
            </button>
            {needsNudge ? (
              <button
                type="button"
                disabled={busy}
                onClick={onContinue}
                className="min-h-8 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-2.5 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-accent-fg)] uppercase transition-[border-color,background-color,transform,opacity] duration-150 hover:border-[color:var(--bo-accent-strong)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
              >
                Continue
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="grid grid-cols-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-0.5">
              <button
                type="button"
                onClick={() => setMode("followUp")}
                aria-pressed={mode === "followUp"}
                className={`min-h-8 px-2.5 text-[10px] font-semibold tracking-[0.14em] uppercase transition-[background-color,color,transform] duration-150 active:scale-[0.96] ${
                  mode === "followUp"
                    ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                    : "text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
                }`}
              >
                Follow up
              </button>
              <button
                type="button"
                onClick={() => setMode("steer")}
                aria-pressed={mode === "steer"}
                className={`min-h-8 px-2.5 text-[10px] font-semibold tracking-[0.14em] uppercase transition-[background-color,color,transform] duration-150 active:scale-[0.96] ${
                  mode === "steer"
                    ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                    : "text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
                }`}
              >
                Steer
              </button>
            </div>
            <button
              type="submit"
              disabled={busy || !draftMessage.trim()}
              className="min-h-8 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 text-[10px] font-semibold tracking-[0.16em] text-[var(--bo-accent-fg)] uppercase transition-[border-color,background-color,transform,opacity] duration-150 hover:border-[color:var(--bo-accent-strong)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
            >
              {busy ? "Sending…" : mode === "steer" ? "Send steer" : "Send follow-up"}
            </button>
          </div>
        </div>
      </div>

      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
    </form>
  );
}

function PendingAssistantCard({
  draftToolCalls,
  runningTools,
  showToolCalls,
  statusText,
}: {
  draftToolCalls: LiveToolCallDraft[];
  runningTools: LiveToolExecution[];
  showToolCalls: boolean;
  statusText: string | null;
}) {
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-prose border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-[var(--bo-fg)]">Assistant</p>
          <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
            {statusText ?? "Waiting for response"}
          </span>
        </div>

        {showToolCalls && (draftToolCalls.length > 0 || runningTools.length > 0) ? (
          <div className="mt-3 space-y-2">
            {draftToolCalls.map((tool) => (
              <ToolCallBlock
                key={tool.key}
                argumentsRawText={tool.argumentsText}
                argumentsValue={tool.argumentsValue ?? tool.argumentsText}
                completedToolResult={null}
                draftTool={tool}
                liveTool={null}
                name={tool.toolName ?? "Tool call"}
              />
            ))}
            {runningTools.map((tool) => (
              <ToolCallBlock
                key={tool.toolCallId}
                argumentsValue={tool.args}
                completedToolResult={null}
                liveTool={tool}
                name={tool.toolName}
              />
            ))}
          </div>
        ) : null}

        {!showToolCalls && (draftToolCalls.length > 0 || runningTools.length > 0) ? (
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            {draftToolCalls.length + runningTools.length} tool call(s) hidden.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function SessionTracePanel({
  traceEvents,
}: {
  traceEvents: Array<Exclude<PiSessionEventStreamItem, { type: "snapshot" }>>;
}) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
      <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
        Trace events
      </p>
      {traceEvents.length === 0 ? (
        <p className="mt-2">No trace events captured.</p>
      ) : (
        <pre className="mt-2 max-h-64 overflow-auto text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
          {formatJson(traceEvents)}
        </pre>
      )}
    </div>
  );
}

function ToggleSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-xs text-[var(--bo-muted)]">
      <span>{label}</span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="group inline-flex h-5 w-9 items-center rounded-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-[2px] transition-colors data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-accent-bg)]"
      >
        <Switch.Thumb className="h-4 w-4 rounded-full bg-[var(--bo-fg)] transition-transform group-data-[checked]:translate-x-4" />
      </Switch.Root>
    </label>
  );
}

function MessageCard({
  draftToolCalls,
  message,
  runningTools,
  showToolCalls,
  showThinking,
  showUsage,
  toolResultsByCallId,
}: {
  draftToolCalls: LiveToolCallDraft[];
  message: AgentMessage;
  runningTools: LiveToolExecution[];
  showToolCalls: boolean;
  showThinking: boolean;
  showUsage: boolean;
  toolResultsByCallId: Map<string, ToolResultMessage>;
}) {
  if (message.role === "user") {
    const contentBlocks = normalizeContent("content" in message ? message.content : undefined);
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-prose border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--bo-fg)]">User</p>
            <time
              suppressHydrationWarning
              dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
              className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase"
            >
              {formatMessageTimestamp(message.timestamp)}
            </time>
          </div>
          <div className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            {contentBlocks.map((block, index) => (
              <ContentBlock key={`${block.type}-${index}`} block={block} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const contentBlocks = normalizeContent("content" in message ? message.content : undefined);
    const toolCalls = contentBlocks.filter((block) => block.type === "toolCall");
    const visibleBlocks = contentBlocks
      .map((block, contentIndex) => ({ block, contentIndex }))
      .filter(({ block }) => {
        if (block.type === "toolCall") {
          return showToolCalls;
        }
        if (block.type === "thinking") {
          return showThinking;
        }
        return true;
      });
    const unmatchedDraftToolCalls = showToolCalls
      ? draftToolCalls.filter(
          (draftTool) =>
            !contentBlocks.some(
              (block, contentIndex) =>
                block.type === "toolCall" &&
                (draftTool.contentIndex === contentIndex || draftTool.toolCallId === block.id),
            ),
        )
      : [];

    return (
      <div className="flex justify-start">
        <div className="w-full max-w-prose border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-[var(--bo-fg)]">Assistant</p>
            <time
              suppressHydrationWarning
              dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
              className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase"
            >
              {formatMessageTimestamp(message.timestamp)}
            </time>
          </div>

          <div className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            {visibleBlocks.length === 0 && unmatchedDraftToolCalls.length === 0 ? (
              contentBlocks.length === 0 ? (
                <span className="inline-flex items-center gap-2 text-xs text-[var(--bo-muted-2)]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
                  Assistant is responding…
                </span>
              ) : (
                <p className="text-xs text-[var(--bo-muted-2)]">No visible content.</p>
              )
            ) : (
              <>
                {visibleBlocks.map(({ block, contentIndex }, index) => {
                  const draftTool =
                    block.type === "toolCall"
                      ? (draftToolCalls.find(
                          (tool) =>
                            tool.contentIndex === contentIndex ||
                            (tool.toolCallId !== null && tool.toolCallId === block.id),
                        ) ?? null)
                      : null;
                  return (
                    <ContentBlock
                      key={`${block.type}-${index}`}
                      block={block}
                      completedToolResult={
                        block.type === "toolCall"
                          ? (toolResultsByCallId.get(block.id) ?? null)
                          : null
                      }
                      draftTool={draftTool}
                      liveTool={
                        block.type === "toolCall"
                          ? (runningTools.find((tool) => tool.toolCallId === block.id) ?? null)
                          : null
                      }
                    />
                  );
                })}
                {unmatchedDraftToolCalls.map((tool) => (
                  <ToolCallBlock
                    key={tool.key}
                    argumentsRawText={tool.argumentsText}
                    argumentsValue={tool.argumentsValue ?? tool.argumentsText}
                    completedToolResult={null}
                    draftTool={tool}
                    liveTool={null}
                    name={tool.toolName ?? "Tool call"}
                  />
                ))}
              </>
            )}
          </div>

          {toolCalls.length > 0 && !showToolCalls ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
              {toolCalls.length} tool call(s) hidden.
            </p>
          ) : null}

          {message.errorMessage ? (
            <p className="mt-2 text-xs text-red-500">{message.errorMessage}</p>
          ) : null}

          {showUsage ? (
            <div className="mt-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-[11px] text-[var(--bo-muted)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                Usage
              </p>
              <p className="mt-1">
                Tokens: {message.usage.input} in · {message.usage.output} out · Total{" "}
                {message.usage.totalTokens}
              </p>
              <p>
                Cost: ${message.usage.cost.total.toFixed(4)} ({message.usage.cost.input.toFixed(4)}{" "}
                in, {message.usage.cost.output.toFixed(4)} out)
              </p>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return null;
}

function ScrollablePre({ children }: { children: string }) {
  return (
    <pre className="max-h-72 max-w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2 font-mono text-[11px] leading-relaxed whitespace-pre text-[var(--bo-fg)]">
      {children}
    </pre>
  );
}

function MarkdownText({ children }: { children: string }) {
  return (
    <Streamdown
      mode="streaming"
      className="bo-session-markdown"
      controls={{ code: true, table: true }}
      skipHtml
    >
      {children}
    </Streamdown>
  );
}

function ContentBlock({
  block,
  completedToolResult = null,
  draftTool = null,
  liveTool = null,
  scrollableText = false,
}: {
  block: ContentBlock;
  completedToolResult?: ToolResultMessage | null;
  draftTool?: LiveToolCallDraft | null;
  liveTool?: LiveToolExecution | null;
  scrollableText?: boolean;
}) {
  switch (block.type) {
    case "text":
      return scrollableText ? (
        <ScrollablePre>{block.text}</ScrollablePre>
      ) : (
        <MarkdownText>{block.text}</MarkdownText>
      );
    case "thinking":
      return (
        <div className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Thinking
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[var(--bo-fg)]">{block.thinking}</p>
        </div>
      );
    case "image":
      return (
        <img
          src={`data:${block.mimeType};base64,${block.data}`}
          alt="Tool output"
          className="max-h-64 max-w-full border border-[color:var(--bo-border)]"
        />
      );
    case "toolCall":
      return (
        <ToolCallBlock
          argumentsRawText={draftTool?.argumentsText}
          argumentsValue={draftTool?.argumentsValue ?? block.arguments}
          completedToolResult={completedToolResult}
          draftTool={draftTool}
          liveTool={liveTool}
          name={draftTool?.toolName ?? block.name}
        />
      );
    default:
      return null;
  }
}

function ToolArgumentsBlock({ rawText, value }: { rawText?: string; value: unknown }) {
  const codeArgument = getCodeArgument(value);

  if (!codeArgument) {
    return <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>;
  }

  const restKeys = Object.keys(codeArgument.rest);

  return (
    <div className="space-y-2">
      {restKeys.length > 0 ? <ScrollablePre>{formatJson(codeArgument.rest)}</ScrollablePre> : null}
      {restKeys.length > 0 ? (
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Code</p>
      ) : null}
      <ScrollablePre>{formatToolArgumentsDisplayText({ rawText, value })}</ScrollablePre>
    </div>
  );
}

function ToolCallBlock({
  argumentsRawText,
  argumentsValue,
  completedToolResult,
  draftTool = null,
  liveTool,
  name,
}: {
  argumentsRawText?: string;
  argumentsValue: unknown;
  completedToolResult: ToolResultMessage | null;
  draftTool?: LiveToolCallDraft | null;
  liveTool: LiveToolExecution | null;
  name: string;
}) {
  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Tool call · {name}
        </p>
        {draftTool && !liveTool ? (
          <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.22em] text-[var(--bo-accent)] uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
            {draftTool.status === "complete" ? "Ready" : "Writing input"}
          </span>
        ) : null}
        {liveTool ? (
          <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.22em] text-[var(--bo-accent)] uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
            Running
          </span>
        ) : null}
      </div>
      <div className="mt-1">
        <ToolArgumentsBlock rawText={argumentsRawText} value={argumentsValue} />
      </div>
      {liveTool && liveTool.partialResult !== null ? (
        <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Live result
          </p>
          <div className="mt-1">
            <ScrollablePre>{formatJson(liveTool.partialResult)}</ScrollablePre>
          </div>
        </div>
      ) : null}
      {completedToolResult ? (
        <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Result
            </p>
            {completedToolResult.isError ? (
              <span className="text-[10px] tracking-[0.22em] text-red-500 uppercase">Error</span>
            ) : null}
          </div>
          <div className="mt-1 min-w-0 space-y-2 text-[11px] text-[var(--bo-fg)]">
            {normalizeContent(completedToolResult.content).map((block, index) => (
              <ContentBlock key={`${block.type}-result-${index}`} block={block} scrollableText />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
