import { useState, type ReactNode } from "react";

import { MessagePrimitive, groupPartByType, useAuiState } from "@assistant-ui/react";

import type { PiAssistantMessageMetadata } from "./assistant-runtime";
import { MarkdownText, MessageImage } from "./message-content";
import { ToolCallBlock } from "./tool-call";
import { formatEventTimestamp, formatMessageTimestamp, tapScale } from "./ui";

const reasoningGrouping = groupPartByType({
  reasoning: ["group-reasoning"],
});

export function UserMessage() {
  const createdAt = useAuiState((state) => state.message.createdAt);

  return (
    <MessagePrimitive.Root className="group relative mb-7 flex justify-end pl-6 sm:pl-24">
      <div className="max-w-[92%] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3 text-sm leading-6 text-[var(--bo-fg)] sm:max-w-[88%]">
        <MessagePrimitive.Parts components={{ Text: MarkdownText, Image: MessageImage }} />
        <time className="mt-1 block text-right text-[10px] text-[var(--bo-muted-2)] tabular-nums">
          {formatMessageTimestamp(createdAt)}
        </time>
      </div>
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage({
  showThinking,
  showToolCalls,
  showUsage,
}: {
  showThinking: boolean;
  showToolCalls: boolean;
  showUsage: boolean;
}) {
  const createdAt = useAuiState((state) => state.message.createdAt);
  const metadata = useAuiState(
    (state) => state.message.metadata.custom as PiAssistantMessageMetadata,
  );
  const outputText = useAuiState((state) =>
    state.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim(),
  );
  const hasToolCalls = useAuiState((state) =>
    state.message.content.some((part) => part.type === "tool-call"),
  );
  const isRunning = useAuiState((state) => state.message.status?.type === "running");
  const isFinalOutput = outputText.length > 0 && !hasToolCalls;
  const isToolCallOnly = hasToolCalls && outputText.length === 0;
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <MessagePrimitive.Root className={`group relative min-w-0 ${isToolCallOnly ? "mb-3" : "mb-9"}`}>
      {isFinalOutput ? (
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-fg)] uppercase">
            Pi
          </span>
          <time className="text-[10px] text-[var(--bo-muted-2)] tabular-nums">
            {formatMessageTimestamp(createdAt)}
          </time>
        </div>
      ) : null}

      <div className="space-y-3 text-sm leading-7 text-[var(--bo-muted)]">
        <MessagePrimitive.GroupedParts groupBy={reasoningGrouping} indicator="no-text">
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning":
                return showThinking ? (
                  <ReasoningBlock createdAt={createdAt} status={part.status.type}>
                    {children}
                  </ReasoningBlock>
                ) : null;
              case "reasoning":
                return showThinking ? <ReasoningText text={part.text} /> : null;
              case "tool-call":
                return showToolCalls ? <ToolCallBlock {...part} /> : null;
              case "text":
                return <MarkdownText text={part.text} />;
              case "image":
                return <MessageImage image={part.image} />;
              case "indicator":
                return <AssistantIndicator label={metadata.statusText} />;
              case "audio":
              case "data":
              case "file":
              case "generative-ui":
              case "source":
                return null;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
      </div>

      {metadata.errorMessage ? (
        <p className="mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]">
          {metadata.errorMessage}
        </p>
      ) : null}

      {showUsage && metadata.usage ? <UsageSummary usage={metadata.usage} /> : null}

      {isFinalOutput && !isRunning ? (
        <div className="mt-3 flex min-h-10 justify-end">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className={`inline-flex min-h-10 items-center px-2 text-[10px] font-medium text-[var(--bo-muted-2)] transition-[color,scale] duration-150 ease-out hover:text-[var(--bo-fg)] ${tapScale}`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function AssistantIndicator({ label }: { label?: string | null }) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-[var(--bo-muted-2)]">
      <span className="size-1.5 animate-pulse rounded-full bg-[var(--bo-accent)]" />
      <span>{label ?? "Working…"}</span>
    </div>
  );
}

function ReasoningBlock({
  children,
  createdAt,
  status,
}: {
  children: ReactNode;
  createdAt?: Date;
  status: string;
}) {
  const running = status === "running";
  return (
    <details
      open={running}
      className="group/thought overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-xs font-medium text-[var(--bo-muted)] marker:hidden">
        <span>{running ? "Working" : "Reasoning"}</span>
        <span className="grid w-[10.5rem] grid-cols-[7rem_3.5rem] items-center text-right text-[10px] text-[var(--bo-muted-2)]">
          <time className="tabular-nums">{formatEventTimestamp(createdAt)}</time>
          <span className="font-medium tracking-[0.1em] uppercase">
            {running ? "Live" : "View"}
          </span>
        </span>
      </summary>
      <div className="space-y-2 border-t border-[color:var(--bo-border)] px-3 py-3">{children}</div>
    </details>
  );
}

function ReasoningText({ text }: { text: string }) {
  return (
    <div className="relative pl-5 text-[var(--bo-muted)] before:absolute before:top-2 before:bottom-2 before:left-1 before:w-px before:bg-[var(--bo-border-strong)]">
      <MarkdownText
        text={text}
        className="text-xs leading-6 [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-xs [&_h4]:text-xs"
      />
    </div>
  );
}

function UsageSummary({ usage }: { usage: NonNullable<PiAssistantMessageMetadata["usage"]> }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--bo-muted-2)] tabular-nums">
      <span>{usage.input.toLocaleString()} input</span>
      <span>{usage.output.toLocaleString()} output</span>
      <span>{usage.totalTokens.toLocaleString()} total</span>
      <span>${usage.cost.total.toFixed(4)}</span>
    </div>
  );
}
