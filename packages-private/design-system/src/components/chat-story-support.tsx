import { useState } from "react";

import { ChatActivity, ChatActivityStep, ChatArtifactToggle } from "./chat-activity";
import {
  ChatComposer,
  ChatComposerButton,
  ChatComposerModel,
  ChatComposerQueueItem,
  ChatComposerSplit,
  ChatComposerStatus,
  ChatComposerToolbar,
  chatComposerInputClassName,
} from "./chat-composer";
import { ChatBoundaryDivider, ChatEventDisclosure, ChatEventDivider } from "./chat-divider";
import {
  ChatAssistantMessage,
  ChatMessageActions,
  ChatTokenUsage,
  ChatUserMessage,
} from "./chat-message";
import { ContextUsageMeter } from "./context-usage-meter";
import { CopyButton } from "./copy-button";
import { LabeledSection } from "./labeled-section";
import { RadioMenu, type RadioMenuOption } from "./radio-menu";
import { ScrollablePre } from "./scrollable-pre";

// Static sample content for the chat stories. Real threads render these components through a
// chat runtime; the stories show the same components with fixed props.

export const SAMPLE_TIME = new Date("2026-10-20T09:41:07");

export const OUT_OF_CONTEXT =
  "Earlier messages are still visible but out of context for the agent due to compaction.";

const ANSWER =
  "Three invoices are still unpaid. The oldest, **INV-4182** from Acme, is 32 days overdue. I drafted a reminder for each in `/workspace/drafts/`.";

const TURN = `### Thinking

Load the unpaid invoices first, then draft one reminder per customer.

### Tool call: execCodeMode (1.2s)

**Arguments**

\`\`\`js
return await invoices.unpaid();
\`\`\`

**Result**

\`\`\`
["INV-4182", "INV-4190", "INV-4203"]
\`\`\`

### Answer

${ANSWER}
`;

type ComposerAction = "message" | "compact";

const COMPOSER_ACTIONS: RadioMenuOption<ComposerAction>[] = [
  {
    value: "message",
    label: "Send message",
    description: "Start or continue the conversation",
    icon: null,
    disabled: false,
  },
  {
    value: "compact",
    label: "Compact context",
    description: "Summarize durable history using the instructions above",
    icon: null,
    disabled: false,
  },
];

export function SampleConversation({
  workflowShown,
  onToggleWorkflow,
}: {
  workflowShown: boolean;
  onToggleWorkflow: () => void;
}) {
  return (
    <>
      <ChatBoundaryDivider>{OUT_OF_CONTEXT}</ChatBoundaryDivider>
      <ChatEventDisclosure
        marker="accent"
        title="Context compacted"
        note="Automatic"
        time={SAMPLE_TIME}
      >
        <p className="text-sm leading-7 text-[var(--bo-muted)]">
          Pi continues from this summary instead of the history before it.
        </p>
      </ChatEventDisclosure>
      <ChatEventDisclosure
        marker="notification"
        title="stripe · invoice.overdue"
        note="via billing-route"
        time={SAMPLE_TIME}
      >
        <pre className="text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
          {`{ "invoice": "INV-4182", "daysOverdue": 32 }`}
        </pre>
      </ChatEventDisclosure>
      <ChatEventDivider marker="notification" time={SAMPLE_TIME}>
        Asked to handle 1 notification
      </ChatEventDivider>
      <ChatUserMessage time={SAMPLE_TIME}>
        <p>Which invoices are still unpaid? Draft reminders for them.</p>
      </ChatUserMessage>
      <ChatAssistantMessage
        author={{ name: "Pi", time: SAMPLE_TIME }}
        footer={
          <>
            <ChatTokenUsage input={18_204} output={612} total={18_816} cost={0.0612} />
            <ChatMessageActions>
              <CopyButton value={ANSWER} label="Copy response" labelled />
              <CopyButton value={TURN} label="Copy full turn" labelled />
            </ChatMessageActions>
          </>
        }
      >
        <ChatActivity
          status={{
            kind: "settled",
            outcome: "done",
            durationMs: 8_400,
            note: "1 tool · 1 thought",
            failedSteps: 0,
          }}
          artifacts={
            <ChatArtifactToggle
              icon="share-2"
              label="Workflow graph"
              labelled
              pressed={workflowShown}
              onClick={onToggleWorkflow}
            />
          }
        >
          <ChatActivityStep
            icon={null}
            state="done"
            title="Loading the unpaid invoices"
            detail={null}
            durationMs={2_100}
            outlined={false}
            actions={null}
          >
            <p className="text-xs leading-6">
              Load the unpaid invoices first, then draft one reminder per customer.
            </p>
          </ChatActivityStep>
          <ChatActivityStep
            icon="code"
            state="done"
            title="execCodeMode"
            detail="invoices.unpaid()"
            durationMs={1_240}
            outlined={false}
            actions={null}
          >
            <ScrollablePre>{"return await invoices.unpaid();"}</ScrollablePre>
            <LabeledSection label="Result">
              <ScrollablePre>{`[\n  "INV-4182",\n  "INV-4190",\n  "INV-4203"\n]`}</ScrollablePre>
            </LabeledSection>
          </ChatActivityStep>
        </ChatActivity>
        <p>
          Three invoices are still unpaid. The oldest, <strong>INV-4182</strong> from Acme, is 32
          days overdue. I drafted a reminder for each in <code>/workspace/drafts/</code>.
        </p>
      </ChatAssistantMessage>
    </>
  );
}

/** A composer without a chat runtime: a plain form whose submit does nothing. */
export function SampleComposer({
  running,
  disabledReason,
  queue,
}: {
  running: boolean;
  disabledReason: string | null;
  queue: readonly { label: string; text: string }[];
}) {
  const [action, setAction] = useState<ComposerAction>("message");
  const disabled = disabledReason !== null;
  return (
    <ChatComposer
      disabled={disabled}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      {queue.map((item) => (
        <ChatComposerQueueItem key={item.text} label={item.label}>
          {item.text}
        </ChatComposerQueueItem>
      ))}
      <textarea
        rows={1}
        disabled={disabled}
        placeholder={
          disabledReason ??
          (action === "compact"
            ? "Tell Pi what the compaction summary must preserve"
            : running
              ? "Steer Pi; it reads this after the current step"
              : "Message Pi")
        }
        className={chatComposerInputClassName}
      />
      <ChatComposerToolbar
        start={
          <>
            <ChatComposerModel>Claude Opus 5.5</ChatComposerModel>
            <ContextUsageMeter tokens={42_000} contextWindow={200_000} />
            {disabledReason === null ? (
              running ? (
                <ChatComposerStatus working>Working…</ChatComposerStatus>
              ) : null
            ) : (
              <ChatComposerStatus working={false}>{disabledReason}</ChatComposerStatus>
            )}
          </>
        }
        end={
          running ? (
            <>
              <ChatComposerButton tone="neutral" joined={false}>
                Stop
              </ChatComposerButton>
              <ChatComposerButton tone="accent" joined={false} type="submit">
                Steer
              </ChatComposerButton>
            </>
          ) : (
            <ChatComposerSplit>
              <ChatComposerButton tone="accent" joined type="submit" disabled={disabled}>
                {action === "compact" ? "Compact" : "Send"}
              </ChatComposerButton>
              <RadioMenu
                label="Choose composer action"
                heading="Composer action"
                trigger={{ kind: "accent" }}
                side="top"
                disabled={disabled}
                value={action}
                options={COMPOSER_ACTIONS}
                onValueChange={setAction}
              />
            </ChatComposerSplit>
          )
        }
      />
    </ChatComposer>
  );
}
