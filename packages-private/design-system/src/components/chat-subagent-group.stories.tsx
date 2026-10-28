import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { ChatActivity, ChatActivityStep } from "./chat-activity";
import { ChatCodemodeStep } from "./chat-codemode-step";
import { ChatEventDivider } from "./chat-divider";
import { ChatAssistantMessage, ChatUserMessage } from "./chat-message";
import { SAMPLE_TIME, SampleComposer } from "./chat-story-support";
import {
  ChatSubagentGroup,
  ChatSubagentsRunning,
  type ChatSubagentRun,
  type ChatSubagentRunStatus,
} from "./chat-subagent-group";
import {
  ChatColumn,
  ChatThread,
  ChatTurnSpacer,
  ChatViewport,
  ChatViewportFooter,
} from "./chat-thread";
import { ScrollablePre } from "./scrollable-pre";

export default { title: "Agents/Chat subagents inline" };

type Document = { id: string; file: string; entry: string };

const DOCUMENTS: Document[] = [
  {
    id: "doc_8f2",
    file: "acme-invoice-4182.pdf",
    entry:
      "Proposed a purchase entry of €1,452.00 on Acme Supplies, booked to 4210 Office supplies with 21% VAT.",
  },
  {
    id: "doc_8f1",
    file: "taxi-receipt.jpg",
    entry: "Proposed a €38.50 expense on 4520 Travel, 9% VAT, paid by the company card.",
  },
  {
    id: "doc_8f0",
    file: "hosting-september.pdf",
    entry: "Proposed a €120.00 purchase on Hetzner, booked to 4610 Hosting, reverse-charged VAT.",
  },
  {
    id: "doc_8e9",
    file: "office-supplies.pdf",
    entry: "Proposed a €64.20 purchase on Staples, booked to 4210 Office supplies with 21% VAT.",
  },
  {
    id: "doc_8e8",
    file: "scan-0042.png",
    entry: "",
  },
];

function task(document: Document) {
  return `Propose the entry for document ${document.id} (${document.file}).`;
}

const HEADLINES = ["Reading the document", "Matching the supplier", "Checking the books"];

/** A subagent's conversation as the row opens it: its work, then its answer. */
function Transcript({ status }: { status: ChatSubagentRunStatus }) {
  const running = status.kind === "running";
  return (
    <div className="space-y-3 text-sm leading-7 text-[var(--bo-muted)]">
      {status.kind === "queued" ? (
        <p className="text-xs text-[var(--bo-muted-2)]">It starts once a slot is free.</p>
      ) : (
        <ChatActivity
          status={
            running
              ? { kind: "running", headline: status.headline, startedAt: status.startedAt }
              : {
                  kind: "settled",
                  outcome:
                    status.kind === "completed"
                      ? "done"
                      : status.kind === "failed"
                        ? "failed"
                        : "stopped",
                  durationMs: status.kind === "completed" ? status.durationMs : null,
                  note: "2 tools",
                  failedSteps: 0,
                }
          }
          artifacts={null}
        >
          <ChatCodemodeStep
            state="done"
            detail={null}
            calls={{
              startedAt: SAMPLE_TIME,
              items: [
                {
                  id: "read",
                  offsetMs: 20,
                  subject: {
                    kind: "call",
                    name: "documents.read",
                    scope: null,
                    input: '{ id: "doc_8f2" }',
                  },
                  status: "succeeded",
                  durationMs: 840,
                },
                {
                  id: "accounts",
                  offsetMs: 900,
                  subject: {
                    kind: "call",
                    name: "ledger.accounts.search",
                    scope: null,
                    input: '"office supplies"',
                  },
                  status: "succeeded",
                  durationMs: 310,
                },
              ],
              unrecorded: 0,
            }}
            durationMs={1_320}
            views={[
              {
                label: "Code",
                content: <ScrollablePre>{"async () => documents.read({ id })"}</ScrollablePre>,
              },
            ]}
            actions={null}
          />
          {running ? (
            <ChatActivityStep
              icon="tool"
              state="running"
              title="bookkeeping.entries.propose"
              detail={null}
              durationMs={null}
              actions={null}
            >
              {null}
            </ChatActivityStep>
          ) : null}
        </ChatActivity>
      )}
      {status.kind === "completed" ? <p>{status.answer}</p> : null}
      {status.kind === "failed" ? (
        <p className="text-xs text-[var(--bo-failed)]">{status.reason}</p>
      ) : null}
    </div>
  );
}

function runs(
  statuses: readonly ChatSubagentRunStatus[],
  documents = DOCUMENTS,
): ChatSubagentRun[] {
  return statuses.map((status, index) => {
    const document = documents[index % documents.length];
    return {
      id: `document:${document.id}:upload:${index}`,
      task: task(document),
      status,
      transcript: <Transcript status={status} />,
    };
  });
}

const FAILED: ChatSubagentRunStatus = {
  kind: "failed",
  reason: "The scan is unreadable: no amounts or supplier found.",
};

function completed(index: number, durationMs: number): ChatSubagentRunStatus {
  return { kind: "completed", durationMs, answer: DOCUMENTS[index].entry };
}

/**
 * The batch's statuses `tick` seconds in: two slots run at once here, each subagent taking a few
 * ticks, and the unreadable scan failing.
 */
function statusesAt(tick: number, startedAt: Date): ChatSubagentRunStatus[] {
  const durations = [3, 4, 3, 2, 2];
  const slots: number[] = [];
  return DOCUMENTS.map((_, index) => {
    // Each takes the earliest slot to free up.
    const start = slots.length < 2 ? 0 : Math.min(...slots);
    if (slots.length >= 2) {
      slots.splice(slots.indexOf(start), 1);
    }
    const end = start + durations[index];
    slots.push(end);
    if (tick < start) {
      return { kind: "queued" };
    }
    if (tick < end) {
      return {
        kind: "running",
        headline: HEADLINES[Math.min(HEADLINES.length - 1, tick - start)],
        startedAt: new Date(startedAt.getTime() + start * 1000),
      };
    }
    return index === 4 ? FAILED : completed(index, durations[index] * 2_300);
  });
}

/** Whether the element shows in the thread's viewport, clear of the composer floating over it. */
function useInView(element: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (element.current === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
      },
      { rootMargin: "0px 0px -224px 0px" },
    );
    observer.observe(element.current);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return inView;
}

// The pane a chat window fills in Backoffice, below the page's tab header.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[48rem] flex-col overflow-hidden border border-[color:var(--bo-border)]">
      <div className="flex h-14 shrink-0 items-center border-b border-[color:var(--bo-border)] px-4">
        <span className="text-sm font-semibold text-[var(--bo-fg)]">Bookkeeper</span>
      </div>
      {children}
    </div>
  );
}

/** Starting the batch, then waiting for it, as the agent's own turn does. */
function BatchTurn({
  statuses,
  startedAt,
}: {
  statuses: readonly ChatSubagentRunStatus[];
  startedAt: Date;
}) {
  const settled = statuses.every(({ kind }) => kind !== "running" && kind !== "queued");
  const answered = statuses.filter(({ kind }) => kind === "completed").length;
  return (
    <ChatActivity
      status={
        settled
          ? {
              kind: "settled",
              outcome: "done",
              durationMs: 14_200,
              note: "2 tools",
              failedSteps: 0,
            }
          : { kind: "running", headline: `Waiting for ${statuses.length} subagents`, startedAt }
      }
      artifacts={null}
    >
      <ChatCodemodeStep
        state="done"
        detail={null}
        calls={{
          startedAt: SAMPLE_TIME,
          items: DOCUMENTS.map((document, index) => ({
            id: document.id,
            offsetMs: 20 + index * 12,
            subject: {
              kind: "call",
              name: "pi.submitPrompt",
              scope: null,
              input: `{ subagent: true, ${document.id} }`,
            },
            status: "succeeded",
            durationMs: 40,
          })),
          unrecorded: 0,
        }}
        durationMs={180}
        views={[
          {
            label: "Code",
            content: (
              <ScrollablePre>{"documents.map((d) => pi.submitPrompt({ ... }))"}</ScrollablePre>
            ),
          },
        ]}
        actions={null}
      />
      <ChatActivityStep
        icon="git-merge"
        state={settled ? "done" : "running"}
        title={
          settled
            ? `Waited for ${statuses.length} subagents · ${answered} answered`
            : `Waiting for subagents · ${answered} of ${statuses.length} answered`
        }
        detail={null}
        durationMs={settled ? 13_900 : null}
        actions={null}
      >
        {null}
      </ChatActivityStep>
    </ChatActivity>
  );
}

/**
 * The agent fans out one subagent per document and waits for them: the batch's card sits in its
 * turn, under the work that started it, and fills in as the subagents run. Replays every 20s.
 */
export function InTurn() {
  const [tick, setTick] = useState(0);
  const [startedAt] = useState(() => new Date());
  const card = useRef<HTMLElement>(null);
  const cardInView = useInView(card);
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((current) => (current + 1) % 20);
    }, 1_000);
    return () => {
      clearInterval(interval);
    };
  }, []);
  const statuses = statusesAt(tick, startedAt);
  const settled = statuses.every(({ kind }) => kind !== "running" && kind !== "queued");
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
              <p>I uploaded this month's receipts. Propose an entry for each.</p>
            </ChatUserMessage>
            <ChatAssistantMessage author={{ name: "Bookkeeper", time: SAMPLE_TIME }} footer={null}>
              <BatchTurn statuses={statuses} startedAt={startedAt} />
              <ChatSubagentGroup ref={card} title="Subagents" subagents={runs(statuses)} />
              {settled ? (
                <p>
                  Four entries are ready for review. I could not read <code>scan-0042.png</code>:
                  could you upload a sharper scan?
                </p>
              ) : null}
            </ChatAssistantMessage>
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert={null}>
            {cardInView ? null : (
              <ChatSubagentsRunning
                statuses={statuses}
                onShow={() => {
                  card.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  card.current?.focus({ preventScroll: true });
                }}
              />
            )}
            <SampleComposer running={!settled} disabledReason={null} queue={[]} />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

const BOOKKEEPING: ChatSubagentRunStatus[] = [
  completed(0, 9_800),
  { kind: "running", headline: "Matching the supplier", startedAt: new Date(Date.now() - 12_000) },
  { kind: "queued" },
];

/**
 * Subagents someone else asked for, here Bookkeeping as documents were uploaded, sit in the thread
 * where they were asked, between the agent's own turns.
 */
export function StartedElsewhere() {
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
              <p>Which invoices are still unpaid?</p>
            </ChatUserMessage>
            <ChatAssistantMessage author={{ name: "Bookkeeper", time: SAMPLE_TIME }} footer={null}>
              <p>
                Three invoices are still unpaid. The oldest, <strong>INV-4182</strong> from Acme, is
                32 days overdue.
              </p>
            </ChatAssistantMessage>
            <ChatEventDivider marker="notification" time={SAMPLE_TIME}>
              Bookkeeping asked for 3 subagents
            </ChatEventDivider>
            <div className="mb-9">
              <ChatSubagentGroup title="Bookkeeping" subagents={runs(BOOKKEEPING)} />
            </div>
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert={null}>
            <SampleComposer running={false} disabledReason={null} queue={[]} />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

const EVERY_STATUS: ChatSubagentRunStatus[] = [
  completed(0, 9_800),
  { kind: "running", headline: "Checking the books", startedAt: new Date(Date.now() - 4_000) },
  { kind: "queued" },
  FAILED,
  { kind: "stopped" },
];

const LARGE_BATCH: ChatSubagentRunStatus[] = Array.from(
  { length: 14 },
  (_, index): ChatSubagentRunStatus =>
    index < 6
      ? completed(index % 4, 6_000 + index * 700)
      : index < 10
        ? {
            kind: "running",
            headline: HEADLINES[index % HEADLINES.length],
            startedAt: new Date(Date.now() - index * 1_000),
          }
        : { kind: "queued" },
);

/** Every status a row shows, a large batch folded after its first rows, and the running notice. */
export function States() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <ChatSubagentGroup title="Subagents" subagents={runs(EVERY_STATUS)} />
      <ChatSubagentGroup title="Subagents" subagents={runs(LARGE_BATCH)} />
      <div>
        <ChatSubagentsRunning statuses={LARGE_BATCH} onShow={() => undefined} />
      </div>
    </div>
  );
}
