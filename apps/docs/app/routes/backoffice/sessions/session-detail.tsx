import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Switch } from "@base-ui/react/switch";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useRevalidator,
} from "react-router";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Route } from "./+types/session-detail";
import { fetchPiSessionDetail, sendPiSessionMessage } from "./data";
import type { PiSessionsOutletContext } from "./sessions";
import { findPiModelOption, parsePiAgentName } from "@/fragno/pi-shared";
import { formatTimestamp } from "./shared";

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

type PiSendMessageActionData = {
  ok: boolean;
  message?: string;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId || !params.sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  const detail = await fetchPiSessionDetail(request, context, params.orgId, params.sessionId);
  if (detail.sessionError || !detail.session) {
    throw new Response(detail.sessionError ?? "Not Found", { status: detail.status ?? 404 });
  }

  return { session: detail.session };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId || !params.sessionId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const rawText = formData.get("text");
  const text = typeof rawText === "string" ? rawText.trim() : "";

  if (!text) {
    console.info("Pi session message skipped: empty text", {
      orgId: params.orgId,
      sessionId: params.sessionId,
    });
    return { ok: false, message: "Message text is required." } satisfies PiSendMessageActionData;
  }

  console.info("Pi session message submit", {
    orgId: params.orgId,
    sessionId: params.sessionId,
    length: text.length,
  });

  const result = await sendPiSessionMessage(request, context, params.orgId, params.sessionId, {
    text,
  });

  if (result.error) {
    console.warn("Pi session message failed", {
      orgId: params.orgId,
      sessionId: params.sessionId,
      error: result.error,
    });
    return { ok: false, message: result.error } satisfies PiSendMessageActionData;
  }

  console.info("Pi session message queued", {
    orgId: params.orgId,
    sessionId: params.sessionId,
    status: result.status,
  });

  return { ok: true } satisfies PiSendMessageActionData;
}

export default function BackofficeOrganisationPiSessionDetail() {
  const { session } = useLoaderData<typeof loader>();
  const { harnesses } = useOutletContext<PiSessionsOutletContext>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [showTrace, setShowTrace] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const formRef = useRef<HTMLFormElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const parsedAgent = parsePiAgentName(session.agent);
  const harnessLabel = parsedAgent
    ? (harnesses.find((entry) => entry.id === parsedAgent.harnessId)?.label ??
      parsedAgent.harnessId)
    : session.agent;
  const modelLabel = parsedAgent
    ? (findPiModelOption(parsedAgent.provider, parsedAgent.model)?.label ?? parsedAgent.model)
    : session.agent;

  const messages = useMemo(() => session.messages ?? [], [session.messages]);
  const traceEvents = session.trace ?? [];
  const sendError = actionData?.ok === false ? actionData.message : null;
  const sending = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.ok) {
      setDraftMessage("");
    }
  }, [actionData]);

  useEffect(() => {
    if (!actionData?.ok) {
      return;
    }
    if (!refreshIntervalRef.current) {
      revalidator.revalidate();
      refreshIntervalRef.current = setInterval(() => {
        revalidator.revalidate();
      }, 1000);
    }
    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [actionData, revalidator]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
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
            Status: {session.status} · Updated {formatTimestamp(session.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => revalidator.revalidate()}
            disabled={revalidator.state === "loading"}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revalidator.state === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <ToggleSwitch
          label="Tool calls"
          checked={showToolCalls}
          onCheckedChange={setShowToolCalls}
        />
        <ToggleSwitch label="Thinking" checked={showThinking} onCheckedChange={setShowThinking} />
        <ToggleSwitch label="Trace" checked={showTrace} onCheckedChange={setShowTrace} />
        <ToggleSwitch label="Usage" checked={showUsage} onCheckedChange={setShowUsage} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
          <ScrollArea.Viewport ref={scrollViewportRef} className="min-h-0 flex-1 p-3">
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
        </ScrollArea.Root>

        <Form
          ref={formRef}
          method="post"
          className="space-y-3 border-t border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Send message
              </p>
              <p className="text-xs text-[var(--bo-muted)]">
                Messages are queued for the workflow. Updates refresh every second after sending.
              </p>
            </div>
            <button
              type="submit"
              disabled={sending || !draftMessage.trim()}
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {sending ? "Sending…" : "Send"}
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
                if (!sending && draftMessage.trim()) {
                  formRef.current?.requestSubmit();
                }
              }
            }}
            placeholder="Type a message for this session…"
            className="focus:ring-[color:var(--bo-accent)]/20 w-full resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
          />
          {sendError ? <p className="text-xs text-red-500">{sendError}</p> : null}
        </Form>
      </div>

      {showTrace ? (
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
      ) : null}
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
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              {formatMessageTimestamp(message.timestamp)}
            </span>
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
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              {formatMessageTimestamp(message.timestamp)}
            </span>
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
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
              {formatMessageTimestamp(message.timestamp)}
            </span>
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
