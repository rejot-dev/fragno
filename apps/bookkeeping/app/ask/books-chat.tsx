import { ChatExtensionsProvider } from "@fragno-private/backoffice-chat/extensions";
import { MarkdownText } from "@fragno-private/backoffice-chat/messages/markdown";
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
import { usePiPendingMessages } from "@fragno-private/backoffice-conversation/projection/pending-messages";
import { MarkdownTextProvider } from "@fragno-private/backoffice-ui/markdown-text";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
} from "@fragno-private/design-system/agents/chat-start";
import { Button } from "@fragno-private/design-system/controls/button";
import { PaneMessage, PaneSpinner } from "@fragno-private/design-system/feedback/pane-message";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExternalThreadQueueAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { ConversationView } from "@earendil-works/pi-durable";

import type { BooksAgentAnswer } from "./agent";

/** What the chat shows of Bookkeeping: only what the agent is called; it shows no files of its own. */
const BOOKS_CHAT_EXTENSIONS = { agentLabel: "Assistant" };

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
      </form>
    </ChatStartPanel>
  );
}

/** The agent's conversation, live from its socket; its first view is the whole conversation. */
export function BooksChat({ agentPath }: { agentPath: string }) {
  const stream = usePiAgentViewSocket({ key: agentPath, url: () => socketUrl(agentPath) });
  if (stream.status === "connecting") {
    return <PaneSpinner label="Loading conversation" />;
  }
  if (stream.status === "failed") {
    return <PaneMessage tone="failed">{stream.message}</PaneMessage>;
  }
  return <BooksChatThread agentPath={agentPath} view={stream.view} queue={stream.queue} />;
}

function isCompacting(view: ConversationView) {
  const live = view.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined;
  return (live?.compactions?.length ?? 0) > 0;
}

/**
 * The conversation as Backoffice's chat shows it, without what only Backoffice offers: files,
 * models, dictation, and managing the agent's context, which the agent compacts itself.
 */
function BooksChatThread({
  agentPath,
  view,
  queue: agentQueue,
}: {
  agentPath: string;
  view: ConversationView;
  queue: PiAgentQueueState;
}) {
  const runtimeRef = useRef<AssistantRuntime | null>(null);
  // Pi's view leads with its newest head marker, where the active context begins.
  const activeContextStart = view.entries[0]?.head ?? null;
  const running = isPiConversationRunning(view);
  const compacting = isCompacting(view);
  const { messages, activeContextStartIndex } = useMemo(
    () => piConversationMessages(view.entries, activeContextStart),
    [activeContextStart, view.entries],
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
      <MarkdownTextProvider component={MarkdownText}>
        <ChatExtensionsProvider value={BOOKS_CHAT_EXTENSIONS}>
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
            hasMoreHistory={false}
            historyLoading={false}
            historyError={null}
            onLoadMoreHistory={async () => undefined}
          />
        </ChatExtensionsProvider>
      </MarkdownTextProvider>
    </AssistantRuntimeProvider>
  );
}
