import { useState, type ReactNode, type RefObject } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Switch } from "@base-ui/react/switch";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { formatTimestamp } from "../shared";

export type LiveToolExecution = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown | null;
};

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

const normalizeContent = (content: AgentMessage["content"]): ContentBlock[] => {
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

export function SessionHeader({
  harnessLabel,
  modelLabel,
  onBack,
  session,
  statusText,
}: {
  harnessLabel: string;
  modelLabel: string;
  onBack: () => void;
  session: {
    id: string;
    name?: string | null;
    status: string;
    updatedAt: string | Date;
  };
  statusText: string | null;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
          Session detail
        </p>
        <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
          {session.name || session.id}
        </h3>
        <p className="text-xs text-[var(--bo-muted-2)]">Session ID: {session.id}</p>
        <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
          {harnessLabel} · {modelLabel}
        </p>
        <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
          Status: {session.status} · Updated{" "}
          <time suppressHydrationWarning dateTime={new Date(session.updatedAt).toISOString()}>
            {formatTimestamp(session.updatedAt)}
          </time>
        </p>
        {statusText ? (
          <div className="border-[color:var(--bo-accent)]/30 mt-2 inline-flex items-center gap-2 border bg-[var(--bo-accent-bg)] px-2.5 py-1 text-[11px] text-[var(--bo-accent-fg)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--bo-accent)]" />
            <span>{statusText}</span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back
        </button>
      </div>
    </div>
  );
}

export function SessionDisplayOptions({
  showThinking,
  showToolCalls,
  showTrace,
  showUsage,
  onShowThinkingChange,
  onShowToolCallsChange,
  onShowTraceChange,
  onShowUsageChange,
}: {
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
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:text-[var(--bo-fg)]"
        >
          Options {expanded ? "−" : "+"}
        </button>
      </div>

      {expanded ? (
        <div className="grid gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 sm:grid-cols-2 lg:grid-cols-4">
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
      ) : null}
    </div>
  );
}

export function SessionConversationPanel({
  footer,
  messages,
  onJumpToLatest,
  onScroll,
  scrollViewportRef,
  showJumpToLatest,
  showThinking,
  showToolCalls,
  showUsage,
}: {
  footer: ReactNode;
  messages: AgentMessage[];
  onJumpToLatest: () => void;
  onScroll: () => void;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  showJumpToLatest: boolean;
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
      <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
        <ScrollArea.Viewport
          ref={scrollViewportRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 p-3"
        >
          <ScrollArea.Content className="space-y-3">
            {messages.length === 0 ? (
              <div className="text-sm text-[var(--bo-muted)]">No messages yet.</div>
            ) : (
              messages.map((message, index) => (
                <MessageCard
                  key={`${message.role}-${index}`}
                  message={message}
                  showToolCalls={showToolCalls}
                  showThinking={showThinking}
                  showUsage={showUsage}
                />
              ))
            )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 select-none p-[2px]">
          <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
        </ScrollArea.Scrollbar>
        <ScrollArea.Corner className="bg-transparent" />

        {showJumpToLatest ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3">
            <button
              type="button"
              onClick={onJumpToLatest}
              className="pointer-events-auto border border-[color:var(--bo-accent)] bg-[var(--bo-panel)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent)] shadow-[0_10px_24px_rgba(0,0,0,0.16)] transition-colors hover:border-[color:var(--bo-accent-strong)] hover:text-[var(--bo-accent-fg)]"
            >
              Jump to latest
            </button>
          </div>
        ) : null}
      </ScrollArea.Root>
      {footer}
    </div>
  );
}

export function SessionComposer({
  busy,
  disabled,
  disabledReason,
  error,
  onSend,
}: {
  busy: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  error: string | null;
  onSend: (text: string) => boolean;
}) {
  const [draftMessage, setDraftMessage] = useState("");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const didSend = onSend(draftMessage);
        if (didSend) {
          setDraftMessage("");
        }
      }}
      className="space-y-3 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
          Send message
        </p>
        <button
          type="submit"
          disabled={disabled || busy || !draftMessage.trim()}
          className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      <textarea
        name="text"
        rows={3}
        value={draftMessage}
        onChange={(event) => setDraftMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            const didSend = onSend(draftMessage);
            if (didSend) {
              setDraftMessage("");
            }
          }
        }}
        placeholder="Type a message for this session…"
        disabled={disabled || busy}
        className="focus:ring-[color:var(--bo-accent)]/20 w-full resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
      />
      {disabledReason ? <p className="text-xs text-[var(--bo-muted)]">{disabledReason}</p> : null}
      {error ? <p className="text-xs text-red-500">{error}</p> : null}
    </form>
  );
}

export function LiveToolsPanel({ tools }: { tools: LiveToolExecution[] }) {
  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {tools.map((tool) => (
        <LiveToolCard key={tool.toolCallId} tool={tool} />
      ))}
    </div>
  );
}

export function SessionTracePanel({ traceEvents }: { traceEvents: AgentEvent[] }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-xs text-[var(--bo-muted)]">
      <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
        Trace events
      </p>
      {traceEvents.length === 0 ? (
        <p className="mt-2">No trace events captured.</p>
      ) : (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--bo-fg)]">
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
  message,
  showToolCalls,
  showThinking,
  showUsage,
}: {
  message: AgentMessage;
  showToolCalls: boolean;
  showThinking: boolean;
  showUsage: boolean;
}) {
  if (message.role === "user") {
    const contentBlocks = normalizeContent(message.content);
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-prose border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--bo-fg)]">User</p>
            <time
              suppressHydrationWarning
              dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
              className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]"
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
    const contentBlocks = normalizeContent(message.content);
    const toolCalls = contentBlocks.filter((block) => block.type === "toolCall");
    const visibleBlocks = contentBlocks.filter((block) => {
      if (block.type === "toolCall") {
        return showToolCalls;
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
            <div>
              <p className="text-xs font-semibold text-[var(--bo-fg)]">Assistant</p>
              <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                {message.provider} · {message.model}
              </p>
            </div>
            <time
              suppressHydrationWarning
              dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
              className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]"
            >
              {formatMessageTimestamp(message.timestamp)}
            </time>
          </div>

          <div className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            {visibleBlocks.length === 0 ? (
              <p className="text-xs text-[var(--bo-muted-2)]">No visible content.</p>
            ) : (
              visibleBlocks.map((block, index) => (
                <ContentBlock key={`${block.type}-${index}`} block={block} />
              ))
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
              <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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

  if (message.role === "toolResult") {
    const contentBlocks = normalizeContent(message.content);
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-md border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--bo-fg)]">
              Tool result · {message.toolName}
            </p>
            <time
              suppressHydrationWarning
              dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}
              className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]"
            >
              {formatMessageTimestamp(message.timestamp)}
            </time>
          </div>
          {message.isError ? (
            <p className="mt-2 text-xs text-red-500">Tool execution failed.</p>
          ) : null}
          <div className="mt-2 space-y-2 text-sm text-[var(--bo-muted)]">
            {contentBlocks.map((block, index) => (
              <ContentBlock key={`${block.type}-${index}`} block={block} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function ContentBlock({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return <p>{block.text}</p>;
    case "thinking":
      return (
        <div className="border border-dashed border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
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
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
          <p className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
            Tool call · {block.name}
          </p>
          <pre className="mt-1 whitespace-pre-wrap text-[11px] text-[var(--bo-fg)]">
            {formatJson(block.arguments)}
          </pre>
        </div>
      );
    default:
      return null;
  }
}

function LiveToolCard({ tool }: { tool: LiveToolExecution }) {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3 text-xs text-[var(--bo-muted)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-[var(--bo-fg)]">Running tool · {tool.toolName}</p>
        <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
          live
        </span>
      </div>
      <pre className="mt-2 whitespace-pre-wrap text-[11px] text-[var(--bo-fg)]">
        {formatJson(tool.args)}
      </pre>
      {tool.partialResult !== null ? (
        <pre className="mt-2 whitespace-pre-wrap border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-[11px] text-[var(--bo-fg)]">
          {formatJson(tool.partialResult)}
        </pre>
      ) : null}
    </div>
  );
}
