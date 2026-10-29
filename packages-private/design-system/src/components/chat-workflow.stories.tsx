import { useEffect, useState, type ComponentProps, type ReactNode } from "react";

import { Button } from "./button";
import { ChatActivity, ChatActivityStep } from "./chat-activity";
import { ChatEventDivider, ChatEventLink } from "./chat-divider";
import { ChatAssistantMessage, ChatUserMessage } from "./chat-message";
import { SAMPLE_TIME, SampleComposer } from "./chat-story-support";
import {
  ChatColumn,
  ChatThread,
  ChatTurnSpacer,
  ChatViewport,
  ChatViewportFooter,
} from "./chat-thread";
import {
  ChatWorkflow,
  ChatWorkflowInputRequest,
  type ChatWorkflowElement,
  type ChatWorkflowStatus,
} from "./chat-workflow";
import { Field } from "./field";
import { KeyValueList } from "./key-value-list";
import { ScrollablePre } from "./scrollable-pre";
import { Select } from "./select";
import { TextArea } from "./text-area";
import { TonedPanel } from "./toned-panel";
import { WorkflowRunTimeline } from "./workflow-run-timeline";
import type {
  WorkflowRunNode,
  WorkflowRunStatus,
  WorkflowRunStep,
} from "./workflow-run-timeline-model";

export default { title: "Agents/Chat workflow" };

// Stand-ins for generated interfaces. In Backoffice the workflow's steps return these as
// generated UI, rendered by the Backoffice UI renderer, whose buttons send workflow events.

const REMINDER =
  "Hi Acme team, INV-4182 ($4,200) is now 32 days overdue. Could you let us know when we can expect payment?";

function ReviewReminderInterface({ onSubmit }: { onSubmit: () => void }) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <KeyValueList
        columns={2}
        items={[
          { key: "invoice", label: "Invoice", value: "INV-4182 · Acme" },
          { key: "overdue", label: "Overdue", value: "32 days · $4,200" },
        ]}
      />
      <Field label="Message" density="compact">
        <TextArea density="compact" rows={3} defaultValue={REMINDER} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" className="min-h-10 px-4 text-xs">
          Send reminder
        </Button>
        <Button variant="secondary" className="min-h-10 px-4 text-xs">
          Skip Acme
        </Button>
      </div>
    </form>
  );
}

function FollowUpInterface({ onSubmit }: { onSubmit: () => void }) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-xs leading-5 text-[var(--bo-muted)]">
        Reminders are out. When should Acme get a second reminder if they have not paid?
      </p>
      <Field label="Follow up" density="compact">
        <Select
          density="compact"
          defaultValue="monday"
          options={[
            { value: "friday", label: "Friday" },
            { value: "monday", label: "Next Monday" },
            { value: "never", label: "Don't follow up" },
          ]}
        />
      </Field>
      <Button type="submit" variant="solid" className="min-h-10 px-4 text-xs">
        Schedule
      </Button>
    </form>
  );
}

function RemindersSentInterface() {
  return (
    <TonedPanel tone="live" label="Reminders sent">
      <KeyValueList
        columns={1}
        items={[
          { key: "acme", label: "INV-4182 · Acme", value: "Follow-up scheduled for Monday" },
          { key: "globex", label: "INV-4190 · Globex", value: "Sent to ap@globex.example" },
          { key: "initech", label: "INV-4203 · Initech", value: "Sent to finance@initech.example" },
        ]}
      />
    </TonedPanel>
  );
}

/**
 * Where the sample run is in its program: load the unpaid invoices, have the reader review Acme's
 * reminder, send a reminder per invoice, have the reader pick a follow-up, and schedule it.
 */
type Phase =
  | "review"
  | "sending"
  | "retrying"
  | "follow-up"
  | "scheduling"
  | "complete"
  | "failed"
  | "stopped";

const PHASE_RUN_STATUS: Record<Phase, WorkflowRunStatus> = {
  review: "waiting",
  sending: "active",
  retrying: "waiting",
  "follow-up": "waiting",
  scheduling: "active",
  complete: "complete",
  failed: "errored",
  stopped: "terminated",
};

/**
 * The step each phase is at, in program order: load, review, send, follow-up, schedule. Steps
 * before it are done; past the last, the run has finished.
 */
const PHASE_STEP: Record<Phase, number> = {
  review: 1,
  sending: 2,
  retrying: 2,
  failed: 2,
  stopped: 1,
  "follow-up": 3,
  scheduling: 4,
  complete: 5,
};

// The run is live, so its steps are laid out relative to when the stories load.
const SAMPLE_START = Date.now() - 30_000;
const at = (seconds: number) => SAMPLE_START + seconds * 1_000;

function sampleStep(
  id: string,
  label: string,
  fields: Partial<Omit<WorkflowRunStep, "id" | "label">>,
): WorkflowRunStep {
  return {
    id,
    label,
    detail: null,
    status: "pending",
    activity: "work",
    attempts: { count: 0, max: 1 },
    timing: { kind: "unstarted" },
    children: [],
    iterations: [],
    ...fields,
  };
}

function ran(startedAt: number, endedAt: number | null) {
  return {
    kind: "span",
    startedAt: at(startedAt),
    endedAt: endedAt === null ? null : at(endedAt),
  } as const;
}

/** One reminder per invoice; while the run sends, the third is still going, retrying, or failed. */
function reminders(phase: Phase): WorkflowRunStep[] {
  const invoices = ["INV-4182", "INV-4190", "INV-4203"];
  return invoices.map((invoice, index) => {
    const step = sampleStep(`send-${invoice}`, `send reminder ${invoice}`, {
      status: "completed",
      attempts: { count: 1, max: 3 },
      timing: ran(6 + index * 3, 8 + index * 3),
    });
    if (index < invoices.length - 1 || PHASE_STEP[phase] > 2) {
      return step;
    }
    switch (phase) {
      case "retrying":
        return {
          ...step,
          status: "waiting",
          attempts: { count: 2, max: 3 },
          detail: "MailboxBusy: retrying in 4 seconds",
          timing: ran(12, null),
        };
      case "failed":
        return {
          ...step,
          status: "failed",
          attempts: { count: 3, max: 3 },
          detail: "MailboxUnavailable: billing@initech.example",
          timing: ran(12, 21),
        };
      case "review":
      case "sending":
      case "follow-up":
      case "scheduling":
      case "complete":
      case "stopped":
        return { ...step, status: "running", timing: ran(12, null) };
    }
    throw new Error("Unsupported sample phase.", { cause: phase satisfies never });
  });
}

function sampleNodes(phase: Phase): WorkflowRunNode[] {
  const reached = PHASE_STEP[phase];
  // A step the run is at has started; one it passed finished.
  const progress = (
    point: number,
    from: number,
    to: number,
    activity: WorkflowRunStep["activity"],
  ): Partial<WorkflowRunStep> =>
    point < reached
      ? { status: "completed", timing: ran(from, to) }
      : point === reached
        ? { status: activity === "wait" ? "waiting" : "running", timing: ran(from, null) }
        : {};
  const sent = reached >= 2 ? reminders(phase) : [];
  const latest = sent.at(-1);
  return [
    {
      kind: "step",
      step: sampleStep("load", "load unpaid invoices", progress(0, 0, 1, "work")),
    },
    {
      kind: "step",
      step: sampleStep("review", "Review the Acme reminder", {
        activity: "wait",
        ...progress(1, 1, 6, "wait"),
      }),
    },
    {
      kind: "loop",
      id: "invoices",
      label: "for (const invoice of invoices)",
      nodes: [
        {
          kind: "step",
          step: sampleStep("send", "send reminder …", {
            ...(latest === undefined
              ? { attempts: { count: 0, max: 3 } }
              : {
                  status: latest.status,
                  attempts: latest.attempts,
                  detail: latest.detail,
                  timing: {
                    kind: "span",
                    startedAt: at(6),
                    endedAt: latest.timing.kind === "span" ? latest.timing.endedAt : null,
                  },
                }),
            iterations: sent,
          }),
        },
      ],
    },
    {
      kind: "step",
      step: sampleStep("follow-up", "Schedule a follow-up", {
        activity: "wait",
        ...progress(3, 15, 24, "wait"),
      }),
    },
    {
      kind: "step",
      step: sampleStep("schedule", "schedule the follow-up", progress(4, 24, 26, "work")),
    },
    { kind: "end", end: { id: "return", label: "return", reason: "return" } },
  ];
}

/** The run's steps as the card shows them. */
function SampleSteps({ phase }: { phase: Phase }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const status = PHASE_RUN_STATUS[phase];
  const ended = status === "complete" || status === "errored" || status === "terminated";
  return (
    <WorkflowRunTimeline
      title={WORKFLOW}
      status={status}
      trigger="pi · tool call"
      createdAt={at(-0.4)}
      startedAt={at(0)}
      endedAt={ended ? at(phase === "failed" ? 21 : 26) : null}
      nodes={sampleNodes(phase)}
      events={[]}
      selectedStepId={selectedStepId}
      onSelectStep={(stepId) => {
        setSelectedStepId((current) => (current === stepId ? null : stepId));
      }}
      presentation={{ kind: "compact" }}
    />
  );
}

// The pane a chat window fills in Backoffice, below the page's tab header.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[46rem] flex-col overflow-hidden border border-[color:var(--bo-border)]">
      {children}
    </div>
  );
}

const WORKFLOW = "Chase unpaid invoices";
const WORKFLOW_ELEMENT_ID = "story-chase-unpaid-invoices";

/** Where the sample run is; each step of the run follows the reader's input or a short delay. */
type Run = "review" | "sending" | "follow-up" | "scheduling" | "complete" | "answered";

const NEXT_RUN: Partial<Record<Run, Run>> = {
  sending: "follow-up",
  scheduling: "complete",
  complete: "answered",
};

const RUN_ORDER: readonly Run[] = [
  "review",
  "sending",
  "follow-up",
  "scheduling",
  "complete",
  "answered",
];

function reached(run: Run, point: Run) {
  return RUN_ORDER.indexOf(run) >= RUN_ORDER.indexOf(point);
}

function useSampleRun(stopped: boolean) {
  const [run, setRun] = useState<Run>("review");
  useEffect(() => {
    const next = NEXT_RUN[run];
    if (next === undefined || stopped) {
      return undefined;
    }
    const timeout = setTimeout(() => {
      setRun(next);
    }, 1_600);
    return () => {
      clearTimeout(timeout);
    };
  }, [run, stopped]);
  return [run, setRun] as const;
}

function sampleStatus(run: Run, stopped: boolean): ChatWorkflowStatus {
  if (stopped) {
    return { kind: "stopped" };
  }
  switch (run) {
    case "review":
      return { kind: "waiting-for-input", step: "Review the Acme reminder" };
    case "sending":
      return { kind: "running" };
    case "follow-up":
      return { kind: "waiting-for-input", step: "Schedule a follow-up" };
    case "scheduling":
      return { kind: "running" };
    case "complete":
    case "answered":
      return { kind: "complete" };
  }
  throw new Error("Unsupported sample run.", { cause: run satisfies never });
}

const RUN_PHASE: Record<Run, Phase> = {
  review: "review",
  sending: "sending",
  "follow-up": "follow-up",
  scheduling: "scheduling",
  complete: "complete",
  answered: "complete",
};

function minutesAfterStart(minutes: number) {
  return new Date(SAMPLE_TIME.getTime() + minutes * 60_000);
}

/**
 * The card holds the whole run: it shows what the run is on now, and its strip jumps back to what
 * the reader entered. Later turns push it up the thread; the request above the composer and the
 * run's completion event both bring the reader back to it.
 */
export function InConversation() {
  const [stopped, setStopped] = useState(false);
  const [run, setRun] = useSampleRun(stopped);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const showWorkflow = () => {
    setSelectedId(null);
    const card = document.getElementById(WORKFLOW_ELEMENT_ID);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    card?.focus({ preventScroll: true });
  };

  const elements: ChatWorkflowElement[] = [
    {
      id: "review-acme-reminder",
      label: "Review the Acme reminder",
      kind: "step",
      content: (
        <ReviewReminderInterface
          onSubmit={() => {
            setRun("sending");
          }}
        />
      ),
    },
    ...(reached(run, "follow-up")
      ? [
          {
            id: "schedule-follow-up",
            label: "Schedule a follow-up",
            kind: "step" as const,
            content: (
              <FollowUpInterface
                onSubmit={() => {
                  setRun("scheduling");
                }}
              />
            ),
          },
        ]
      : []),
    ...(reached(run, "complete") && !stopped
      ? [
          {
            id: "output",
            label: "Result",
            kind: "output" as const,
            content: <RemindersSentInterface />,
          },
        ]
      : []),
  ];
  const status = sampleStatus(run, stopped);

  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
              <p>Chase the unpaid invoices. Let me check the Acme one before it goes out.</p>
            </ChatUserMessage>
            <ChatAssistantMessage author={{ name: "Pi", time: SAMPLE_TIME }} footer={null}>
              <ChatActivity
                status={{
                  kind: "settled",
                  outcome: "done",
                  durationMs: 6_200,
                  note: "1 tool · 1 thought",
                  failedSteps: 0,
                }}
                artifacts={null}
              >
                <ChatActivityStep
                  icon={null}
                  state="done"
                  title="Starting a reminder workflow"
                  detail={null}
                  durationMs={1_900}
                  actions={null}
                >
                  <p className="text-xs leading-6">
                    Acme needs a review before sending, so pause the workflow on their reminder.
                  </p>
                </ChatActivityStep>
                <ChatActivityStep
                  icon="code"
                  state="done"
                  title="codemode"
                  detail="workflows.start(chaseUnpaidInvoices)"
                  durationMs={840}
                  actions={null}
                >
                  <ScrollablePre>
                    {"return await workflows.start(chaseUnpaidInvoices);"}
                  </ScrollablePre>
                </ChatActivityStep>
              </ChatActivity>
              <ChatWorkflow
                id={WORKFLOW_ELEMENT_ID}
                name={WORKFLOW}
                status={status}
                elements={elements}
                steps={<SampleSteps phase={stopped ? "stopped" : RUN_PHASE[run]} />}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onStop={
                  status.kind === "complete" || status.kind === "stopped"
                    ? null
                    : async () => {
                        setStopped(true);
                      }
                }
              />
              <p>I started a workflow that sends a reminder for each unpaid invoice.</p>
            </ChatAssistantMessage>

            <ChatUserMessage time={minutesAfterStart(2)} attachments={null}>
              <p>While that runs: how much is outstanding in total?</p>
            </ChatUserMessage>
            <ChatAssistantMessage author={{ name: "Pi", time: minutesAfterStart(2) }} footer={null}>
              <p>
                <strong>$9,850</strong> across the three invoices: $4,200 from Acme, $3,400 from
                Globex, and $2,250 from Initech.
              </p>
            </ChatAssistantMessage>

            {reached(run, "complete") && !stopped ? (
              <>
                <ChatEventLink
                  marker="live"
                  title="workflows · instance.completed"
                  note={WORKFLOW}
                  time={minutesAfterStart(5)}
                  action="View result"
                  onShow={showWorkflow}
                />
                <ChatEventDivider marker="notification" time={minutesAfterStart(5)}>
                  Asked to handle 1 notification
                </ChatEventDivider>
              </>
            ) : null}
            {reached(run, "answered") && !stopped ? (
              <ChatAssistantMessage
                author={{ name: "Pi", time: minutesAfterStart(5) }}
                footer={null}
              >
                <p>Done. If Acme hasn&apos;t paid by Monday, they get a second reminder.</p>
              </ChatAssistantMessage>
            ) : null}
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert={null}>
            <ChatWorkflowInputRequest
              requests={
                status.kind === "waiting-for-input"
                  ? [{ id: WORKFLOW_ELEMENT_ID, name: WORKFLOW, step: status.step }]
                  : []
              }
              onShow={showWorkflow}
            />
            <SampleComposer running={false} disabledReason={null} queue={[]} />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">{children}</div>;
}

const REVIEW: ChatWorkflowElement = {
  id: "review-acme-reminder",
  label: "Review the Acme reminder",
  kind: "step",
  content: <ReviewReminderInterface onSubmit={() => undefined} />,
};

const FOLLOW_UP: ChatWorkflowElement = {
  id: "schedule-follow-up",
  label: "Schedule a follow-up",
  kind: "step",
  content: <FollowUpInterface onSubmit={() => undefined} />,
};

const RESULT: ChatWorkflowElement = {
  id: "output",
  label: "Result",
  kind: "output",
  content: <RemindersSentInterface />,
};

/** A card whose strip the reader can use, as Backoffice keeps the selection per run. */
function Workflow({
  phase,
  ...props
}: Omit<
  ComponentProps<typeof ChatWorkflow>,
  "name" | "selectedId" | "onSelect" | "onStop" | "steps"
> & {
  /** Where the run is in its steps; null while they are not known. */
  phase: Phase | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <ChatWorkflow
      name={WORKFLOW}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onStop={null}
      steps={phase === null ? null : <SampleSteps phase={phase} />}
      {...props}
    />
  );
}

export function States() {
  return (
    <Column>
      <Workflow phase={null} status={{ kind: "synchronizing" }} elements={[]} />
      <Workflow
        phase="review"
        status={{ kind: "waiting-for-input", step: "Review the Acme reminder" }}
        elements={[REVIEW]}
      />
      <Workflow phase="sending" status={{ kind: "running" }} elements={[REVIEW]} />
      <Workflow phase="retrying" status={{ kind: "waiting" }} elements={[REVIEW]} />
      <Workflow
        phase="follow-up"
        status={{ kind: "waiting-for-input", step: "Schedule a follow-up" }}
        elements={[REVIEW, FOLLOW_UP]}
      />
      <Workflow phase="scheduling" status={{ kind: "running" }} elements={[REVIEW, FOLLOW_UP]} />
      <Workflow
        phase="complete"
        status={{ kind: "complete" }}
        elements={[REVIEW, FOLLOW_UP, RESULT]}
      />
      <Workflow phase="stopped" status={{ kind: "stopped" }} elements={[REVIEW]} />
      <Workflow
        phase="failed"
        status={{
          kind: "failed",
          step: "send reminder INV-4203",
          error: "MailboxUnavailable: billing@initech.example",
        }}
        elements={[REVIEW]}
      />
      <Workflow
        phase={null}
        status={{
          kind: "synchronization-failed",
          error: "Workflow synchronization failed: the run's durable object is unreachable.",
        }}
        elements={[]}
      />
    </Column>
  );
}

// A batched mirror part way through its downloads: the steps before and after its loop only
// show once the reader asks for them.
const MIRROR_BATCHES = 7;

function mirrorStep(id: string, label: string, from: number, to: number | null): WorkflowRunNode {
  return {
    kind: "step",
    step: sampleStep(id, label, to === null ? {} : { status: "completed", timing: ran(from, to) }),
  };
}

function mirrorNodes(): WorkflowRunNode[] {
  const batches = Array.from({ length: MIRROR_BATCHES }, (_, index) => {
    const running = index === MIRROR_BATCHES - 1;
    return sampleStep(`download-${index}`, `download files ${index * 8}`, {
      status: running ? "running" : "completed",
      attempts: { count: index === 2 ? 2 : 1, max: 3 },
      timing: ran(3 + index * 3.5, running ? null : 6 + index * 3.5),
    });
  });
  const latest = batches.at(-1);
  return [
    mirrorStep("fetch", "fetch repository", 0, 1),
    mirrorStep("list", "list files", 1, 2),
    mirrorStep("pin", "pin main snapshot", 2, 3),
    {
      kind: "loop",
      id: "batches",
      label: "for (let i = 0; i < plan.count; i += 8)",
      nodes: [
        {
          kind: "step",
          step: sampleStep("download", "download files …", {
            status: "running",
            attempts: latest?.attempts ?? { count: 1, max: 3 },
            timing: { kind: "span", startedAt: at(3), endedAt: null },
            iterations: batches,
          }),
        },
      ],
    },
    mirrorStep("verify", "verify checksums", 0, null),
    mirrorStep("manifest", "write manifest", 0, null),
    mirrorStep("publish", "publish verified snapshot", 0, null),
    { kind: "end", end: { id: "return", label: "return", reason: "return" } },
  ];
}

/** A long run keeps the card short: it shows where the run is, and the rest on request. */
export function LongRun() {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  return (
    <Column>
      <ChatWorkflow
        name="kc-initial-mirror"
        status={{ kind: "running" }}
        elements={[]}
        steps={
          <WorkflowRunTimeline
            title="kc-initial-mirror"
            status="active"
            trigger="manual"
            createdAt={at(-0.2)}
            startedAt={at(0)}
            endedAt={null}
            nodes={mirrorNodes()}
            events={[]}
            selectedStepId={selectedStepId}
            onSelectStep={(stepId) => {
              setSelectedStepId((current) => (current === stepId ? null : stepId));
            }}
            presentation={{ kind: "compact" }}
          />
        }
        selectedId={null}
        onSelect={() => undefined}
        onStop={async () => undefined}
      />
    </Column>
  );
}

/** Stopping asks once more in place, then reports a failure beside the retry. */
export function Stop() {
  const [stopped, setStopped] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <Column>
      <ChatWorkflow
        name={WORKFLOW}
        status={
          stopped
            ? { kind: "stopped" }
            : { kind: "waiting-for-input", step: "Review the Acme reminder" }
        }
        elements={[REVIEW]}
        steps={<SampleSteps phase={stopped ? "stopped" : "review"} />}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onStop={
          stopped
            ? null
            : async () => {
                await new Promise((resolve) => {
                  setTimeout(resolve, 600);
                });
                setStopped(true);
              }
        }
      />
      <ChatWorkflow
        name="Archive old invoices"
        status={{ kind: "running" }}
        elements={[]}
        steps={<SampleSteps phase="sending" />}
        selectedId={null}
        onSelect={() => undefined}
        onStop={async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 600);
          });
          throw new Error("The run already ended.");
        }}
      />
    </Column>
  );
}

/** Several runs waiting at once name the first; the rest follow once the reader goes to it. */
export function InputRequest() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-2 p-6">
      <ChatWorkflowInputRequest
        requests={[{ id: "chase", name: WORKFLOW, step: "Review the Acme reminder" }]}
        onShow={() => undefined}
      />
      <ChatWorkflowInputRequest
        requests={[
          { id: "chase", name: WORKFLOW, step: "Review the Acme reminder" },
          { id: "upload", name: "Upload a contract", step: "Choose the file" },
        ]}
        onShow={() => undefined}
      />
    </div>
  );
}
