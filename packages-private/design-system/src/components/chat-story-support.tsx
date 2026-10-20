import { useState } from "react";

import { ActivityDisclosure } from "./activity-disclosure";
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
import { ChatBoundaryDivider, ChatEventDivider } from "./chat-divider";
import {
  ChatAssistantMessage,
  ChatEventMessage,
  ChatMessageActions,
  ChatReasoningTrace,
  ChatTokenUsage,
  ChatToolCallRow,
  ChatUserMessage,
} from "./chat-message";
import { ContextUsageMeter } from "./context-usage-meter";
import { CopyButton } from "./copy-button";
import { LabeledSection } from "./labeled-section";
import { PanelToggleButton } from "./panel-toggle-button";
import { RadioMenu, type RadioMenuOption } from "./radio-menu";
import { ScrollablePre } from "./scrollable-pre";

// Static sample content for the chat stories. Real threads render these components through a
// chat runtime; the stories show the same components with fixed props.

export const SAMPLE_TIME = new Date("2026-10-20T09:41:07");

export const OUT_OF_CONTEXT =
  "Earlier messages are still visible but out of context for the agent due to compaction.";

const ANSWER =
  "Three invoices are still unpaid. The oldest, **INV-4182** from Acme, is 32 days overdue. I drafted a reminder for each in `/workspace/drafts/`.";

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
      <ChatEventMessage>
        <ActivityDisclosure
          marker="accent"
          title="Context compacted"
          note="Automatic"
          time={SAMPLE_TIME}
        >
          <p className="text-sm leading-7 text-[var(--bo-muted)]">
            Pi continues from this summary instead of the history before it.
          </p>
        </ActivityDisclosure>
      </ChatEventMessage>
      <ChatEventMessage>
        <ActivityDisclosure
          marker="notification"
          title="stripe · invoice.overdue"
          note="via billing-route"
          time={SAMPLE_TIME}
        >
          <pre className="text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
            {`{ "invoice": "INV-4182", "daysOverdue": 32 }`}
          </pre>
        </ActivityDisclosure>
      </ChatEventMessage>
      <ChatEventDivider marker="notification" time={SAMPLE_TIME}>
        Asked to handle 1 notification
      </ChatEventDivider>
      <ChatUserMessage time={SAMPLE_TIME}>
        <p>Which invoices are still unpaid? Draft reminders for them.</p>
      </ChatUserMessage>
      <ChatAssistantMessage spacing="tight" author={null} footer={null}>
        <ActivityDisclosure marker={null} title="Reasoning" time={SAMPLE_TIME}>
          <ChatReasoningTrace>
            <p className="text-xs leading-6">
              Load the unpaid invoices first, then draft one reminder per customer.
            </p>
          </ChatReasoningTrace>
        </ActivityDisclosure>
        <ChatToolCallRow
          actions={
            <PanelToggleButton
              icon="share-2"
              label="Workflow graph"
              pressed={workflowShown}
              onClick={onToggleWorkflow}
            />
          }
        >
          <ActivityDisclosure marker="live" title="execCodeMode" detail="Done" time={SAMPLE_TIME}>
            <ScrollablePre>{"return await invoices.unpaid();"}</ScrollablePre>
            <LabeledSection label="Result">
              <ScrollablePre>{`[\n  "INV-4182",\n  "INV-4190",\n  "INV-4203"\n]`}</ScrollablePre>
            </LabeledSection>
          </ActivityDisclosure>
        </ChatToolCallRow>
      </ChatAssistantMessage>
      <ChatAssistantMessage
        spacing="normal"
        author={{ name: "Pi", time: SAMPLE_TIME }}
        footer={
          <>
            <ChatTokenUsage input={18_204} output={612} total={18_816} cost={0.0612} />
            <ChatMessageActions>
              <CopyButton value={ANSWER} label="Copy response" />
            </ChatMessageActions>
          </>
        }
      >
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
