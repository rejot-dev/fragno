import { ScrollArea } from "@base-ui/react/scroll-area";
import { Switch } from "@base-ui/react/switch";
import type {
  DraftAgentMessage,
  DraftTool,
} from "@fragno-dev/pi-harness/client/workflow-lofi-session-projection";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { Streamdown } from "streamdown";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

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

const formatJsonString = (value: string) => {
  try {
    return formatJson(JSON.parse(value));
  } catch {
    return value;
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

const getReadPath = (value: unknown) => {
  if (!isRecord(value) || typeof value.path !== "string") {
    return null;
  }
  return value.path;
};

const getSkillNameFromPath = (path: string | null | undefined) => {
  if (!path) {
    return null;
  }

  const pathSegments = path.split(/[\\/]+/).filter(Boolean);
  if (pathSegments.at(-1) !== "SKILL.md") {
    return null;
  }

  return pathSegments.at(-2) ?? null;
};

const getLoadedSkillName = ({
  argumentsValue,
  completedToolResult,
  name,
}: {
  argumentsValue: unknown;
  completedToolResult: ToolResultMessage | null;
  name: string;
}) => {
  if (name !== "read" || !completedToolResult || completedToolResult.isError) {
    return null;
  }

  const resultPath = getReadPath(completedToolResult.details);
  const argumentPath = getReadPath(argumentsValue);
  return getSkillNameFromPath(resultPath ?? argumentPath);
};

const formatExecCodeModeExpandedResult = (result: ToolResultMessage) => {
  if (!isRecord(result.details)) {
    return null;
  }

  const lines: string[] = [];
  if (Array.isArray(result.details.logs)) {
    lines.push(...result.details.logs.filter((line): line is string => typeof line === "string"));
  }

  if ("result" in result.details && result.details.result !== undefined) {
    const resultText =
      typeof result.details.result === "string"
        ? formatJsonString(result.details.result)
        : formatJson(result.details.result);
    lines.push(resultText);
  }

  return lines.length > 0 ? lines.join("\n") : null;
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
  showUsage,
  onShowThinkingChange,
  onShowToolCallsChange,
  onShowUsageChange,
}: {
  exportFilename: string;
  exportHref: string;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
  onShowThinkingChange: (value: boolean) => void;
  onShowToolCallsChange: (value: boolean) => void;
  onShowUsageChange: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-auto space-y-2 sm:min-w-96">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setExpanded((current) => !current);
          }}
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
  draftAgentMessage,
  messages,
  onJumpToLatest,
  onScroll,
  readyForInput,
  scrollContentRef,
  scrollViewportRef,
  showJumpToLatest,
  showThinking,
  showToolCalls,
  showUsage,
  statusText,
}: {
  draftAgentMessage: DraftAgentMessage | null;
  messages: AgentMessage[];
  onJumpToLatest: () => void;
  onScroll: () => void;
  readyForInput: boolean;
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
                  draftAgentMessage={message === lastMessage ? draftAgentMessage : null}
                  message={message}
                  showToolCalls={showToolCalls}
                  showThinking={showThinking}
                  showUsage={showUsage}
                  toolResultsByCallId={toolResultsByCallId}
                />
              ))
            )}

            {showPendingAssistant ? (
              <PendingAssistantCard
                draftAgentMessage={draftAgentMessage}
                showThinking={showThinking}
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
  onContinue: () => unknown;
  onSend: (command: { kind: "followUp" | "steer"; text: string }) => Promise<boolean> | boolean;
  onStop: () => unknown;
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
        void submitDraft();
      }}
      className="flex-none border border-t-0 border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-0"
    >
      <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset] transition-colors duration-150 focus-within:border-[color:var(--bo-accent)] focus-within:ring-2 focus-within:ring-[color:var(--bo-accent)]/15">
        <textarea
          ref={textareaRef}
          name="text"
          rows={1}
          value={draftMessage}
          onChange={(event) => {
            setDraftMessage(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              void submitDraft();
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
              onClick={() => {
                void onStop();
              }}
              className="min-h-8 border border-red-400/40 bg-red-500/10 px-2.5 text-[10px] font-semibold tracking-[0.14em] text-red-500 uppercase transition-[border-color,background-color,transform,opacity] duration-150 hover:border-red-400 hover:bg-red-500/15 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
            >
              Stop
            </button>
            {needsNudge ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void onContinue();
                }}
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
                onClick={() => {
                  setMode("followUp");
                }}
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
                onClick={() => {
                  setMode("steer");
                }}
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
  draftAgentMessage,
  showThinking,
  showToolCalls,
  statusText,
}: {
  draftAgentMessage: DraftAgentMessage | null;
  showThinking: boolean;
  showToolCalls: boolean;
  statusText: string | null;
}) {
  const draftTools = Object.values(draftAgentMessage?.tools ?? {});
  const contentBlocks = normalizeContent(draftAgentMessage?.assistant?.content);
  const visibleBlocks = contentBlocks.filter((block) => {
    if (block.type === "toolCall") {
      return false;
    }
    if (block.type === "thinking") {
      return showThinking;
    }
    return true;
  });

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

        {visibleBlocks.length > 0 ? (
          <div className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            {visibleBlocks.map((block, index) => (
              <ContentBlock key={`${block.type}-${index}`} block={block} />
            ))}
          </div>
        ) : null}

        {showToolCalls && draftTools.length > 0 ? (
          <div className="mt-3 space-y-2">
            {draftTools.map((tool) => (
              <ToolCallBlock
                key={tool.id}
                argumentsValue={tool.args}
                completedToolResult={tool.resultMessage ?? null}
                draftTool={tool}
                name={tool.name}
              />
            ))}
          </div>
        ) : null}

        {!showToolCalls && draftTools.length > 0 ? (
          <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
            {draftTools.length} tool call(s) hidden.
          </p>
        ) : null}
      </div>
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
  draftAgentMessage,
  message,
  showToolCalls,
  showThinking,
  showUsage,
  toolResultsByCallId,
}: {
  draftAgentMessage: DraftAgentMessage | null;
  message: AgentMessage;
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
    const draftTools = Object.values(draftAgentMessage?.tools ?? {});
    const unmatchedDraftTools = showToolCalls
      ? draftTools.filter(
          (draftTool) =>
            !contentBlocks.some((block) => block.type === "toolCall" && draftTool.id === block.id),
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
            {visibleBlocks.length === 0 && unmatchedDraftTools.length === 0 ? (
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
                {visibleBlocks.map(({ block }, index) => {
                  const draftTool =
                    block.type === "toolCall"
                      ? (draftTools.find((tool) => tool.id === block.id) ?? null)
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
                    />
                  );
                })}
                {unmatchedDraftTools.map((tool) => (
                  <ToolCallBlock
                    key={tool.id}
                    argumentsValue={tool.args}
                    completedToolResult={tool.resultMessage ?? null}
                    draftTool={tool}
                    name={tool.name}
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
  scrollableText = false,
}: {
  block: ContentBlock;
  completedToolResult?: ToolResultMessage | null;
  draftTool?: DraftTool | null;
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
          argumentsValue={draftTool?.args ?? block.arguments}
          completedToolResult={draftTool?.resultMessage ?? completedToolResult}
          draftTool={draftTool}
          name={draftTool?.name ?? block.name}
        />
      );
    default:
      return null;
  }
}

function ToolArgumentsBlock({ value }: { value: unknown }) {
  const codeArgument = getCodeArgument(value);

  if (!codeArgument) {
    return <ScrollablePre>{formatToolArgumentsDisplayText({ value })}</ScrollablePre>;
  }

  const restKeys = Object.keys(codeArgument.rest);

  return (
    <div className="space-y-2">
      {restKeys.length > 0 ? <ScrollablePre>{formatJson(codeArgument.rest)}</ScrollablePre> : null}
      {restKeys.length > 0 ? (
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Code</p>
      ) : null}
      <ScrollablePre>{formatToolArgumentsDisplayText({ value })}</ScrollablePre>
    </div>
  );
}

function ToolCallBlock({
  argumentsValue,
  completedToolResult,
  draftTool = null,
  name,
}: {
  argumentsValue: unknown;
  completedToolResult: ToolResultMessage | null;
  draftTool?: DraftTool | null;
  name: string;
}) {
  const [resultExpanded, setResultExpanded] = useState(false);
  const loadedSkillName = getLoadedSkillName({ argumentsValue, completedToolResult, name });
  if (loadedSkillName) {
    return <SkillLoadedBlock name={loadedSkillName} />;
  }

  const canExpandResult = name === "execCodeMode" && completedToolResult !== null;

  return (
    <div className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          Tool call · {name}
        </p>
        {draftTool ? (
          <span className="inline-flex items-center gap-2 text-[10px] tracking-[0.22em] text-[var(--bo-accent)] uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
            {draftTool.status === "running"
              ? "Running"
              : draftTool.status === "done"
                ? "Done"
                : "Writing input"}
          </span>
        ) : null}
      </div>
      <div className="mt-1">
        <ToolArgumentsBlock value={argumentsValue} />
      </div>
      {draftTool?.partialResult !== undefined ? (
        <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Live result
          </p>
          <div className="mt-1">
            <ScrollablePre>{formatJson(draftTool.partialResult)}</ScrollablePre>
          </div>
        </div>
      ) : null}
      {completedToolResult ? (
        <div className="mt-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Result
            </p>
            <div className="flex items-center gap-2">
              {completedToolResult.isError ? (
                <span className="text-[10px] tracking-[0.22em] text-red-500 uppercase">Error</span>
              ) : null}
              {canExpandResult ? (
                <button
                  type="button"
                  aria-label={
                    resultExpanded ? "Collapse execCodeMode result" : "Expand execCodeMode result"
                  }
                  title={resultExpanded ? "Collapse result" : "Expand result"}
                  onClick={() => {
                    setResultExpanded((current) => !current);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] transition-[border-color,color,transform] duration-150 hover:border-[color:var(--bo-accent)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
                >
                  {resultExpanded ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
            </div>
          </div>
          <ToolResultContent
            expanded={canExpandResult && resultExpanded}
            result={completedToolResult}
            useExecCodeModeFormatting={canExpandResult}
          />
        </div>
      ) : null}
    </div>
  );
}

function ToolResultContent({
  expanded,
  result,
  useExecCodeModeFormatting,
}: {
  expanded: boolean;
  result: ToolResultMessage;
  useExecCodeModeFormatting: boolean;
}) {
  const expandedText = useExecCodeModeFormatting ? formatExecCodeModeExpandedResult(result) : null;

  if (expanded && expandedText !== null) {
    return (
      <pre className="mt-2 max-h-[70vh] min-h-64 max-w-full overflow-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--bo-fg)]">
        {expandedText}
      </pre>
    );
  }

  return (
    <div className="mt-1 min-w-0 space-y-2 text-[11px] text-[var(--bo-fg)]">
      {normalizeContent(result.content).map((block, index) => (
        <ContentBlock key={`${block.type}-result-${index}`} block={block} scrollableText />
      ))}
    </div>
  );
}

function SkillLoadedBlock({ name }: { name: string }) {
  return (
    <div className="min-w-0 border border-[oklch(0.76_0.14_178/0.45)] bg-[oklch(0.76_0.14_178/0.10)] p-2 text-xs text-[var(--bo-fg)] shadow-[0_0_0_1px_oklch(0.76_0.14_178/0.08)_inset]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex items-center gap-2 text-[10px] font-semibold tracking-[0.22em] text-[oklch(0.76_0.14_178)] uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-[oklch(0.76_0.14_178)] shadow-[0_0_12px_oklch(0.76_0.14_178/0.55)]" />
          Skill loaded
        </p>
        <span className="border border-[oklch(0.76_0.14_178/0.35)] bg-[var(--bo-panel)] px-2 py-1 font-mono text-[10px] text-[var(--bo-fg)]">
          {name}
        </span>
      </div>
    </div>
  );
}
