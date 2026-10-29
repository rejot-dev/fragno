import { useEffect, useState } from "react";

import { Button } from "../button";
import { ChatActivity, ChatActivityStep } from "../chat-activity";
import { ChatAssistantMessage, ChatUserMessage } from "../chat-message";
import { ChatWorkflow, type ChatWorkflowElement, type ChatWorkflowStatus } from "../chat-workflow";
import { Field } from "../field";
import { KeyValueList } from "../key-value-list";
import { ScrollablePre } from "../scrollable-pre";
import { TextArea } from "../text-area";
import { TonedPanel } from "../toned-panel";

const DRAFT_REPLY =
  "Hi Maya,\n\nThanks for getting in touch about Cedar Physio. I'd be glad to show you around. Does Tuesday or Wednesday next week work for a 30-minute call?\n\nThe Harbor team";

// The part of the written workflow that pauses for the reader; the helpers live further down the
// same file.
const WORKFLOW_EXCERPT = `const { fit } = await step.do("classify request", () => classify(lead));
await step.do("announce lead", () =>
  events.fire({ source: "leads", eventType: "lead.qualified", payload: { lead, fit } }),
);

const review = ui.form("reply-decision", { decision: "send", reply: draftFor(lead) });
await step.do("review reply", () => ({ $ui: ui.render(reviewForm(lead, fit, review)) }));
const { payload } = await step.waitForEvent("wait for your decision", {
  type: review.eventType,
});

if (payload.decision === "send") {
  await step.do("send reply by email", () => sendReply(lead.email, payload.reply));
}`;

/** Where the run is: waiting on the reader, sending what they approved, or done. */
type Run =
  | { kind: "review" }
  | { kind: "sending"; reply: string }
  | { kind: "sent"; reply: string }
  | { kind: "skipped" };

/**
 * The agent turning one request into workflows, and the first run stopping to ask the reader. The
 * reader answers in the run's card, the way they would in Backoffice.
 */
export function LandingDemo() {
  const [run, setRun] = useState<Run>({ kind: "review" });
  // Null follows the run; the card's strip lets the reader look back at what they answered.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (run.kind !== "sending") {
      return undefined;
    }
    const timeout = setTimeout(() => {
      setRun({ kind: "sent", reply: run.reply });
    }, 1_200);
    return () => {
      clearTimeout(timeout);
    };
  }, [run]);

  const elements: ChatWorkflowElement[] = [
    {
      id: "review-reply",
      label: "Review reply to Maya Chen",
      kind: "step",
      content: (
        <ReviewReply
          onSend={(reply) => {
            setRun({ kind: "sending", reply });
          }}
          onSkip={() => {
            setRun({ kind: "skipped" });
          }}
        />
      ),
    },
    ...(run.kind === "sent" || run.kind === "skipped"
      ? [{ id: "result", label: "Result", kind: "output" as const, content: <Result run={run} /> }]
      : []),
  ];

  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-bg)] shadow-[var(--bo-panel-shadow)]">
      <div className="mx-auto max-w-3xl px-4 pt-8 pb-2 sm:px-8 sm:pt-10">
        <ChatUserMessage time={null} attachments={null}>
          <p>
            When someone fills in our contact form, qualify them, add them to HubSpot, and tell
            sales on Slack. Show me replies before they go out.
          </p>
        </ChatUserMessage>
        <ChatAssistantMessage author={{ name: "Assistant", time: null }} footer={null}>
          <ChatActivity
            status={{
              kind: "settled",
              outcome: "done",
              durationMs: 9_400,
              note: "4 tools",
              failedSteps: 0,
            }}
            artifacts={null}
          >
            <ChatActivityStep
              icon="file-text"
              state="done"
              title="Wrote qualify-lead.workflow.js"
              detail={null}
              durationMs={3_100}
              actions={null}
            >
              <ScrollablePre>{WORKFLOW_EXCERPT}</ScrollablePre>
            </ChatActivityStep>
            <ChatActivityStep
              icon="file-text"
              state="done"
              title="Wrote sync-hubspot.workflow.js"
              detail={null}
              durationMs={1_800}
              actions={null}
            >
              {null}
            </ChatActivityStep>
            <ChatActivityStep
              icon="file-text"
              state="done"
              title="Wrote notify-sales.workflow.js"
              detail={null}
              durationMs={1_600}
              actions={null}
            >
              {null}
            </ChatActivityStep>
            <ChatActivityStep
              icon="zap"
              state="done"
              title="Added 3 routes"
              detail={null}
              durationMs={900}
              actions={null}
            >
              {null}
            </ChatActivityStep>
          </ChatActivity>
          <p>Set up. Maya Chen just filled in the form, and her reply is ready for you.</p>
          <ChatWorkflow
            name="qualify-lead"
            status={workflowStatus(run)}
            elements={elements}
            // The demo's run has no recorded steps to show.
            steps={null}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onStop={null}
          />
        </ChatAssistantMessage>
      </div>
    </div>
  );
}

function workflowStatus(run: Run): ChatWorkflowStatus {
  switch (run.kind) {
    case "review":
      return { kind: "waiting-for-input", step: "Review reply to Maya Chen" };
    case "sending":
      return { kind: "running" };
    case "sent":
    case "skipped":
      return { kind: "complete" };
  }
  throw new Error("Unsupported demo run.", { cause: run satisfies never });
}

function ReviewReply({ onSend, onSkip }: { onSend: (reply: string) => void; onSkip: () => void }) {
  const [reply, setReply] = useState(DRAFT_REPLY);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSend(reply);
      }}
    >
      <KeyValueList
        columns={2}
        items={[
          { key: "company", label: "Company", value: "Cedar Physio" },
          { key: "fit", label: "Fit", value: "Good fit" },
        ]}
      />
      <p className="text-xs leading-5 text-[var(--bo-muted)]">
        “We run three clinics and want to move bookings off spreadsheets. Could we see a demo next
        week?”
      </p>
      <Field label="Reply" density="compact">
        <TextArea
          density="compact"
          rows={6}
          value={reply}
          onChange={(event) => {
            setReply(event.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" className="min-h-10 px-4 text-xs">
          Send reply
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-10 px-4 text-xs"
          onClick={onSkip}
        >
          Don’t reply
        </Button>
      </div>
    </form>
  );
}

function Result({ run }: { run: Extract<Run, { kind: "sent" | "skipped" }> }) {
  if (run.kind === "skipped") {
    return (
      <TonedPanel tone="muted" label="No reply sent">
        <p className="text-xs leading-5 text-[var(--bo-muted)]">
          Maya stays in HubSpot, and sales already knows about her.
        </p>
      </TonedPanel>
    );
  }
  return (
    <TonedPanel tone="live" label="Reply sent">
      <KeyValueList
        columns={1}
        items={[
          { key: "to", label: "To", value: "maya@cedarphysio.test" },
          { key: "reply", label: "Reply", value: run.reply },
        ]}
      />
    </TonedPanel>
  );
}
