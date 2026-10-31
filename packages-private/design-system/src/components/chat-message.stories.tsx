import { useState, type ReactNode } from "react";

import { ChatActivity, ChatActivityStep } from "./chat-activity";
import { ChatBoundaryDivider, ChatEventDisclosure, ChatEventDivider } from "./chat-divider";
import {
  ChatAssistantMessage,
  ChatMessageActions,
  ChatStoppedNotice,
  ChatTokenUsage,
  ChatUserMessage,
} from "./chat-message";
import { OUT_OF_CONTEXT, SAMPLE_TIME } from "./chat-story-support";
import { CopyButton } from "./copy-button";
import { InlineAlert } from "./inline-alert";
import { WorkingIndicator } from "./working-indicator";

export default { title: "Agents/Chat messages" };

function Column({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-3xl flex-col">{children}</div>;
}

export function UserAndAnswer() {
  return (
    <Column>
      <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
        <p>How much revenue did we book last week?</p>
      </ChatUserMessage>
      <ChatAssistantMessage
        author={{ name: "Pi", time: SAMPLE_TIME }}
        footer={
          <>
            <ChatTokenUsage input={12_480} output={318} total={12_798} cost={0.0421} />
            <ChatMessageActions>
              <CopyButton value="€48,200 across 31 invoices." label="Copy response" text={null} />
            </ChatMessageActions>
          </>
        }
      >
        <p>€48,200 across 31 invoices, up 12% on the week before.</p>
      </ChatAssistantMessage>
    </Column>
  );
}

export function Working() {
  const [startedAt] = useState(() => new Date(Date.now() - 4_000));
  return (
    <Column>
      <ChatAssistantMessage author={{ name: "Pi", time: SAMPLE_TIME }} footer={null}>
        <ChatActivity
          status={{ kind: "running", headline: "Grouping invoices by week", startedAt }}
          artifacts={null}
        >
          <ChatActivityStep
            icon={null}
            state="running"
            title="Grouping invoices by week"
            detail={null}
            durationMs={null}
            actions={null}
          >
            <p className="text-xs leading-6">Grouping invoices by the week they were issued.</p>
          </ChatActivityStep>
        </ChatActivity>
      </ChatAssistantMessage>
    </Column>
  );
}

/**
 * What the agent says between its steps stays between their cards: the work before it folds to a
 * summary, and the work after it opens a new card below.
 */
export function Interleaved() {
  const [startedAt] = useState(() => new Date(Date.now() - 9_000));
  return (
    <Column>
      <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
        <p>Send a reminder for every unpaid invoice.</p>
      </ChatUserMessage>
      <ChatAssistantMessage author={{ name: "Pi", time: SAMPLE_TIME }} footer={null}>
        <ChatActivity
          status={{
            kind: "settled",
            outcome: "done",
            durationMs: null,
            note: "1 tool · 1 thought",
            failedSteps: 0,
          }}
          artifacts={null}
        >
          <ChatActivityStep
            icon={null}
            state="done"
            title="Finding the unpaid invoices"
            detail={null}
            durationMs={null}
            actions={null}
          >
            <p className="text-xs leading-6">Load the open invoices, then check which are due.</p>
          </ChatActivityStep>
          <ChatActivityStep
            icon="code"
            state="done"
            title="invoices.unpaid"
            detail={null}
            durationMs={1_180}
            actions={null}
          >
            {null}
          </ChatActivityStep>
        </ChatActivity>
        <p>Three invoices are open. Drafting a reminder for each customer now.</p>
        <ChatActivity
          status={{ kind: "running", headline: "Drafting one reminder per customer", startedAt }}
          artifacts={null}
        >
          <ChatActivityStep
            icon={null}
            state="running"
            title="Drafting one reminder per customer"
            detail={null}
            durationMs={null}
            actions={null}
          >
            <p className="text-xs leading-6">
              Acme is 32 days overdue, so their reminder should be firmer than the others.
            </p>
          </ChatActivityStep>
        </ChatActivity>
      </ChatAssistantMessage>
    </Column>
  );
}

/**
 * Once the agent has said something, its text stops moving while it thinks about its next step;
 * the indicator below keeps the turn from reading as finished.
 */
export function WorkingAfterSpeaking() {
  return (
    <Column>
      <ChatUserMessage time={SAMPLE_TIME} attachments={null}>
        <p>Send a reminder for every unpaid invoice.</p>
      </ChatUserMessage>
      <ChatAssistantMessage author={{ name: "Pi", time: SAMPLE_TIME }} footer={null}>
        <ChatActivity
          status={{
            kind: "settled",
            outcome: "done",
            durationMs: null,
            note: "1 tool · 1 thought",
            failedSteps: 0,
          }}
          artifacts={null}
        >
          <ChatActivityStep
            icon="code"
            state="done"
            title="invoices.unpaid"
            detail={null}
            durationMs={1_180}
            actions={null}
          >
            {null}
          </ChatActivityStep>
        </ChatActivity>
        <p>Three invoices are open. Drafting a reminder for each customer now.</p>
        <WorkingIndicator>Working…</WorkingIndicator>
      </ChatAssistantMessage>
    </Column>
  );
}

export function StoppedAndFailed() {
  return (
    <Column>
      <ChatAssistantMessage author={{ name: "Pi", time: null }} footer={<ChatStoppedNotice />}>
        <p>Looking up the overdue invoices…</p>
      </ChatAssistantMessage>
      <ChatAssistantMessage
        author={{ name: "Pi", time: null }}
        footer={<InlineAlert>The model provider returned an overloaded error.</InlineAlert>}
      >
        <p>Drafting the reminders now.</p>
      </ChatAssistantMessage>
    </Column>
  );
}

export function Dividers() {
  return (
    <Column>
      <ChatBoundaryDivider>{OUT_OF_CONTEXT}</ChatBoundaryDivider>
      <ChatEventDivider marker="notification" time={SAMPLE_TIME} title="evt_42 via billing-route">
        Asked to handle 1 notification
      </ChatEventDivider>
      <ChatEventDisclosure
        defaultOpen={false}
        marker="accent"
        title="Context compacted"
        note="Requested"
        time={null}
      >
        <p className="text-xs leading-6 text-[var(--bo-muted)]">The summary Pi continues from.</p>
      </ChatEventDisclosure>
    </Column>
  );
}
