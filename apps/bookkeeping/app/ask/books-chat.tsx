import {
  ChatExtensionsProvider,
  type ChatExtensions,
  type ChatToolCall,
} from "@fragno-private/backoffice-chat/extensions";
import { MarkdownImage, MarkdownText } from "@fragno-private/backoffice-chat/messages/markdown";
import { SessionThread } from "@fragno-private/backoffice-chat/thread/session-thread";
import {
  usePiAgentViewSocket,
  type PiAgentQueueState,
} from "@fragno-private/backoffice-conversation/live/view-socket";
import {
  createAssistantUiMessages,
  getAppendMessageText,
  isPiConversationRunning,
  piConversationDraftAgentMessage,
  piConversationMessages,
  piConversationQueue,
  type PiUserMessageMetadata,
} from "@fragno-private/backoffice-conversation/projection/assistant-runtime";
import {
  usePiEarlierHistory,
  type PiHistoryPageReader,
} from "@fragno-private/backoffice-conversation/projection/earlier-history";
import { usePiPendingMessages } from "@fragno-private/backoffice-conversation/projection/pending-messages";
import { MarkdownTextProvider } from "@fragno-private/backoffice-ui/markdown-text";
import { ChatActivityStep } from "@fragno-private/design-system/agents/chat-activity";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
  ChatStartSuggestions,
} from "@fragno-private/design-system/agents/chat-start";
import { Button } from "@fragno-private/design-system/controls/button";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import { z } from "zod";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

import { agentStepLine, agentSteps, type AgentStep } from "../books/agent-steps";
import type { BooksOutletContext } from "../books/layout";
import type { BooksAgentAnswer } from "./agent";
import { booksRehypePlugins } from "./books-links";

/** The steps of one of the agent's tool calls, as Bookkeeping names them. */
function toolCallSteps(call: ChatToolCall): AgentStep[] {
  return agentSteps([{ running: call.state === "running", calls: call.calls?.items ?? null }]);
}

/**
 * One of the agent's tool calls, as the steps of its work the books' people know: Bookkeeping's
 * actions and its reads of files, without the code that ran them. A call that failed outside its
 * steps says so after them.
 */
function BooksToolCall({ call }: { call: ChatToolCall }) {
  const lines = toolCallSteps(call).map(agentStepLine);
  if (call.state === "failed" && !lines.some((line) => line.state === "failed")) {
    lines.push({ icon: "cpu", label: "Ran into a problem", detail: null, state: "failed" });
  }
  return lines.map((line, position) => (
    <ChatActivityStep
      // Steps have no IDs, and a step keeps its place as the work goes on.
      key={position}
      icon={line.state === "failed" ? "alert-triangle" : line.icon}
      state={line.state}
      title={line.label}
      detail={line.detail}
      durationMs={null}
      actions={null}
    >
      {null}
    </ChatActivityStep>
  ));
}

/** What the chat shows of Bookkeeping: what the agent is called, and its work as steps. */
const BOOKS_CHAT_EXTENSIONS: Partial<ChatExtensions> = {
  agentLabel: "Assistant",
  toolCalls: {
    Step: BooksToolCall,
    headline: (call) =>
      toolCallSteps(call)
        .map(agentStepLine)
        .filter((line) => line.state === "running")
        .at(-1)?.label ?? "Working",
  },
};

type Books = BooksOutletContext["books"];

/** A link the agent wrote to the books, to the page `rehypeBooksLinks` resolved. */
function BooksLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to}>{children}</Link>;
}

const booksMarkdownComponents = {
  img: MarkdownImage,
  // Only rehypeBooksLinks creates these elements, with a path it resolved in these books.
  "books-link": BooksLink as ComponentType,
};

/** Markdown whose links to the books lead to their pages (see `BOOKS_LINKS`). */
function useBooksMarkdown(books: Books, base: string) {
  return useMemo(() => {
    const rehypePlugins = booksRehypePlugins(books, base);
    return function BooksMarkdownText({ text, className }: { text: string; className?: string }) {
      return (
        <MarkdownText
          text={text}
          className={className}
          components={booksMarkdownComponents}
          rehypePlugins={rehypePlugins}
        />
      );
    };
  }, [books, base]);
}

/** Asks, stops, or resumes the agent through `agentPath`; returns why Backoffice refused, or null. */
async function postToAgent(agentPath: string, fields: Record<string, string>) {
  const response = await fetch(agentPath, {
    method: "POST",
    headers: { accept: "application/json" },
    body: new URLSearchParams(fields),
  }).catch(() => null);
  if (!response?.headers.get("content-type")?.includes("application/json")) {
    return "Bookkeeping could not be reached. Try again shortly.";
  }
  // Bookkeeping's own resource route answers in this shape.
  const answer = (await response.json()) as BooksAgentAnswer;
  return answer.error;
}

/** A new URL of the agent's socket, with a ticket for one connection. */
async function socketUrl(agentPath: string): Promise<string> {
  const response = await fetch(agentPath, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`The agent's socket could not be opened (HTTP ${response.status}).`);
  }
  return z.object({ url: z.string() }).parse(await response.json()).url;
}

/** Questions the start panel offers; picking one fills the field without sending it. */
const SUGGESTIONS = [
  "How are we doing this year so far?",
  "What do customers still owe us?",
  "What were our largest expenses last month?",
  "Which documents still need booking?",
];

/**
 * Asks the agent its first question, which starts its conversation; `onStarted` then shows the
 * conversation, which opens only once it started.
 */
export function BooksChatStart({
  agentPath,
  onStarted,
}: {
  agentPath: string;
  onStarted: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async () => {
    const content = question.trim();
    if (!content || sending) {
      return;
    }
    setSending(true);
    setError(null);
    const refusal = await postToAgent(agentPath, {
      intent: "ask",
      requestId: crypto.randomUUID(),
      content,
    });
    setSending(false);
    if (refusal === null) {
      onStarted();
    } else {
      setError(refusal);
    }
  };
  return (
    <ChatStartPanel
      title="Ask about your books"
      description="An assistant reads these books and answers your questions: what was booked and why, balances, open items, and what the numbers mean. Everyone in this workspace shares the conversation."
      details={null}
    >
      <form
        className="w-full"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <ChatPromptField
          id="books-chat-question"
          label="Question"
          name="content"
          required
          autoFocus
          rows={3}
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="What did we spend on rent this year?"
        />
        <ChatStartFooter
          note="The assistant reads the books and changes nothing."
          action={
            <Button type="submit" variant="solid" disabled={sending || !question.trim()}>
              {sending ? "Sending…" : "Send"}
            </Button>
          }
          alert={error}
        />
        <ChatStartSuggestions
          suggestions={SUGGESTIONS}
          onPick={(suggestion) => {
            setQuestion(suggestion);
            document.getElementById("books-chat-question")?.focus();
          }}
        />
      </form>
    </ChatStartPanel>
  );
}

/** Where the chat asks the agent and reads its earlier history; see `ask/agent` and `ask/history`. */
type BooksChatPaths = { agentPath: string; historyPath: string };

/** The agent's conversation, live from its socket, with what came before its newest compaction. */
export function BooksChat({
  paths,
  books,
  base,
}: {
  paths: BooksChatPaths;
  books: Books;
  base: string;
}) {
  const stream = usePiAgentViewSocket({
    key: paths.agentPath,
    url: () => socketUrl(paths.agentPath),
  });
  const BooksMarkdownText = useBooksMarkdown(books, base);
  if (stream.status === "connecting") {
    return <PaneSpinner label="Loading conversation" />;
  }
  if (stream.status === "failed") {
    return <PaneMessage tone="failed">{stream.message}</PaneMessage>;
  }
  return (
    <MarkdownTextProvider component={BooksMarkdownText}>
      <ChatExtensionsProvider value={BOOKS_CHAT_EXTENSIONS}>
        <BooksChatThread paths={paths} view={stream.view} queue={stream.queue} />
      </ChatExtensionsProvider>
    </MarkdownTextProvider>
  );
}

/** Reads earlier history through `historyPath`, as the person reading the chat. */
function useHistoryPageReader(historyPath: string): PiHistoryPageReader {
  return useCallback(
    async ({ before, cursor }) => {
      const query = new URLSearchParams({ before: String(before) });
      if (cursor !== null) {
        query.set("cursor", cursor);
      }
      const response = await fetch(`${historyPath}?${query}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Earlier messages could not be loaded (HTTP ${response.status}).`);
      }
      return historyPageSchema.parse(await response.json());
    },
    [historyPath],
  );
}

// Entries pass as Pi Durable wrote them: Backoffice answered them, and the projection reads them.
const historyPageSchema = z.object({
  entries: z.array(z.custom<EntryRecord>()),
  cursor: z.string().nullable(),
});

function isCompacting(view: ConversationView) {
  const live = view.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined;
  return (live?.compactions?.length ?? 0) > 0;
}

/**
 * The conversation as Backoffice's chat shows it, without what only Backoffice offers: files,
 * models, dictation, and managing the agent's context, which the agent compacts itself.
 */
function BooksChatThread({
  paths: { agentPath, historyPath },
  view,
  queue: agentQueue,
}: {
  paths: BooksChatPaths;
  view: ConversationView;
  queue: PiAgentQueueState;
}) {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  const history = usePiEarlierHistory(view, useHistoryPageReader(historyPath));
  const { activeContextStart, transcript } = history;
  const running = isPiConversationRunning(view);
  const compacting = isCompacting(view);
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(transcript, activeContextStart),
    [activeContextStart, transcript],
  );
  const draftAgentMessage = useMemo(() => piConversationDraftAgentMessage(view), [view]);
  const {
    messages: pendingMessages,
    add: addPendingMessage,
    withdraw: withdrawPendingMessage,
  } = usePiPendingMessages(view, agentQueue.items);
  // A question asked during a run waits in the queue; otherwise it starts a turn in the thread.
  const conversationQueue = useMemo(() => {
    const queue = piConversationQueue(view, agentQueue.items);
    if (!running) {
      return queue;
    }
    const labels = new Map(queue.labels);
    const sending = pendingMessages.map(({ requestId, text }) => {
      const id = `pending:${requestId}`;
      labels.set(id, "Sending");
      return { id, prompt: text };
    });
    return { items: [...queue.items, ...sending], labels };
  }, [view, agentQueue.items, running, pendingMessages]);
  const statusText = compacting ? "Compacting…" : running ? "Working…" : null;
  const { assistantMessages, activeContextStartMessageId } = useMemo(() => {
    const converted = createAssistantUiMessages({
      draftAgentMessage,
      messages,
      activeContextStartIndex,
      readyForInput: !running,
      statusText,
    });
    const sending = running
      ? []
      : pendingMessages.map(
          ({ requestId, text }): ThreadMessageLike => ({
            id: `pending-${requestId}`,
            role: "user",
            content: [{ type: "text", text }],
            metadata: {
              custom: { kind: "user", attachments: [] } satisfies PiUserMessageMetadata,
            },
          }),
        );
    return {
      assistantMessages: [...converted.messages, ...sending],
      activeContextStartMessageId: converted.activeContextStartMessageId,
    };
  }, [activeContextStartIndex, draftAgentMessage, messages, running, statusText, pendingMessages]);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A question shows at once and is withdrawn when Backoffice refuses it.
  const send = useCallback(
    async (message: AppendMessage) => {
      const text = getAppendMessageText(message);
      if (!text) {
        return;
      }
      setError(null);
      const requestId = crypto.randomUUID();
      addPendingMessage(requestId, text);
      setSendingMessage(true);
      const refusal = await postToAgent(agentPath, { intent: "ask", requestId, content: text });
      setSendingMessage(false);
      setError(refusal);
      if (refusal !== null) {
        withdrawPendingMessage(requestId);
        // The text returns to the composer unless the reader already started another question.
        const composer = runtimeRef.current?.thread.composer;
        if (composer?.getState().text === "") {
          composer.setText(text);
        }
      }
    },
    [agentPath, addPendingMessage, withdrawPendingMessage],
  );

  // The agent's queue owns what waits; this adapter keeps the composer usable during a run.
  const queue = useMemo<ExternalThreadQueueAdapter>(
    () => ({
      items: conversationQueue.items,
      enqueue: (message) => {
        void send(message);
      },
      // Bookkeeping asks every question to join the running turn.
      steer: () => undefined,
      // The thread renders no remove control; queued items cannot be withdrawn yet.
      remove: () => undefined,
      // Stopping the agent withdraws queued input on the server.
      clear: () => undefined,
    }),
    [send, conversationQueue.items],
  );
  const runtime = useExternalStoreRuntime({
    messages: assistantMessages,
    convertMessage: (message) => message,
    isRunning: running,
    // A stop or resume in flight could overtake a question that reached the agent first.
    isSendDisabled: sendingMessage || controlling,
    onNew: send,
    queue,
  });
  useEffect(() => {
    runtimeRef.current = runtime;
    return () => {
      runtimeRef.current = null;
    };
  }, [runtime]);

  const control = (intent: "stop" | "resume") => async () => {
    setControlling(true);
    setError(await postToAgent(agentPath, { intent }));
    setControlling(false);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionThread
        dictation={false}
        attachments={null}
        disabledReason={null}
        error={error}
        queueLabels={conversationQueue.labels}
        paused={agentQueue.paused && agentQueue.items.length > 0}
        onResume={control("resume")}
        model={null}
        needsNudge={false}
        onContinue={() => undefined}
        onStop={control("stop")}
        readyForInput={!running}
        running={running}
        subagentsRunning={false}
        showThinking
        showToolCalls
        showUsage={false}
        statusText={statusText}
        compacting={compacting}
        context={null}
        activeContextStartMessageId={activeContextStartMessageId}
        hasMoreHistory={history.hasMore}
        historyLoading={history.loading}
        historyError={history.error}
        onLoadMoreHistory={history.loadMore}
      />
    </AssistantRuntimeProvider>
  );
}
