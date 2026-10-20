import type { ReactNode } from "react";

import { ActivityDisclosure } from "./activity-disclosure";
import { ChatBoundaryDivider, ChatEventDivider } from "./chat-divider";
import {
  ChatAssistantMessage,
  ChatMessageActions,
  ChatReasoningTrace,
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
      <ChatUserMessage time={SAMPLE_TIME}>
        <p>How much revenue did we book last week?</p>
      </ChatUserMessage>
      <ChatAssistantMessage
        spacing="normal"
        author={{ name: "Pi", time: SAMPLE_TIME }}
        footer={
          <>
            <ChatTokenUsage input={12_480} output={318} total={12_798} cost={0.0421} />
            <ChatMessageActions>
              <CopyButton value="€48,200 across 31 invoices." label="Copy response" />
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
  return (
    <Column>
      <ChatAssistantMessage spacing="normal" author={null} footer={null}>
        <ActivityDisclosure marker="progress" title="Working" time={SAMPLE_TIME} autoOpen>
          <ChatReasoningTrace>
            <p className="text-xs leading-6">Grouping invoices by the week they were issued.</p>
          </ChatReasoningTrace>
        </ActivityDisclosure>
        <WorkingIndicator>Working…</WorkingIndicator>
      </ChatAssistantMessage>
    </Column>
  );
}

export function StoppedAndFailed() {
  return (
    <Column>
      <ChatAssistantMessage spacing="normal" author={null} footer={<ChatStoppedNotice />}>
        <p>Looking up the overdue invoices…</p>
      </ChatAssistantMessage>
      <ChatAssistantMessage
        spacing="normal"
        author={null}
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
    </Column>
  );
}
