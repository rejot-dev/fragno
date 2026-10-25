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
      return { kind: "running", step: "Sending reminders" };
    case "follow-up":
      return { kind: "waiting-for-input", step: "Schedule a follow-up" };
    case "scheduling":
      return { kind: "running", step: "Scheduling the follow-up" };
    case "complete":
    case "answered":
      return { kind: "complete" };
  }
  throw new Error("Unsupported sample run.", { cause: run satisfies never });
}

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
            <ChatUserMessage time={SAMPLE_TIME}>
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
                  outlined={false}
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
                  outlined={false}
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

            <ChatUserMessage time={minutesAfterStart(2)}>
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
function Workflow(
  props: Omit<ComponentProps<typeof ChatWorkflow>, "name" | "selectedId" | "onSelect" | "onStop">,
) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <ChatWorkflow
      name={WORKFLOW}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onStop={null}
      {...props}
    />
  );
}

export function States() {
  return (
    <Column>
      <Workflow status={{ kind: "synchronizing" }} elements={[]} />
      <Workflow status={{ kind: "running", step: "Loading unpaid invoices" }} elements={[]} />
      <Workflow
        status={{ kind: "waiting-for-input", step: "Review the Acme reminder" }}
        elements={[REVIEW]}
      />
      <Workflow status={{ kind: "running", step: "Sending reminders" }} elements={[REVIEW]} />
      <Workflow
        status={{ kind: "waiting-for-input", step: "Schedule a follow-up" }}
        elements={[REVIEW, FOLLOW_UP]}
      />
      <Workflow
        status={{ kind: "waiting", step: "Wait until Monday" }}
        elements={[REVIEW, FOLLOW_UP]}
      />
      <Workflow status={{ kind: "complete" }} elements={[REVIEW, FOLLOW_UP, RESULT]} />
      <Workflow status={{ kind: "stopped" }} elements={[REVIEW]} />
      <Workflow
        status={{
          kind: "failed",
          step: "Sending reminders",
          error: "Email provider rejected billing@acme.example: mailbox unavailable.",
        }}
        elements={[REVIEW]}
      />
      <Workflow
        status={{
          kind: "synchronization-failed",
          error: "Workflow synchronization failed: the run's durable object is unreachable.",
        }}
        elements={[]}
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
        status={{ kind: "running", step: "Moving invoices to the archive" }}
        elements={[]}
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
