import type { CodemodeRun } from "@fragno-private/backoffice-conversation/format/codemode-result";
import type { PiAgentNotification } from "@fragno-private/backoffice-conversation/format/notification-entry";
import type { PiAgentAttachment } from "@fragno-private/backoffice-conversation/format/prompt-attachments";
import { ChatEventDisclosure } from "@fragno-private/design-system/agents/chat-divider";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

/** One of the agent's subagents reporting how it ended, as the thread names it. */
export type ChatSubagentReport = {
  task: string;
  outcome: string;
  /** Brings the reader to its card; null while the thread does not show the card. */
  show: (() => void) | null;
};

/**
 * What the chat shows of the host around the conversation: its files, workflows, and subagents.
 * Without one, the chat shows less of the conversation, never something else.
 */
export type ChatExtensions = {
  /** What the thread calls the agent, e.g. as its messages' author. */
  agentLabel: string;
  /** The files a user's message carried; null shows none. */
  UserAttachments: ComponentType<{ attachments: readonly PiAgentAttachment[] }> | null;
  /** A run a codemode program started or showed, after the work that showed it last. */
  WorkflowRun: ComponentType<{ run: CodemodeRun }> | null;
  /** What a tool call started beside the conversation, such as subagents, after its work. */
  ToolCallFollowUps: ComponentType<{ toolCallId: string }> | null;
  /** Above the composer: work beside the conversation, or waiting on the reader. */
  composerHeader: ReactNode;
  /** The thread's system messages of kinds the host adds, by kind. */
  systemMessages: Readonly<Record<string, ComponentType>>;
  /** Which events report one of the agent's subagents ending; null for any other event. */
  useSubagentReports: (
    notifications: readonly PiAgentNotification[],
  ) => (ChatSubagentReport | null)[];
  /** One event delivered to the agent. */
  NotificationLine: ComponentType<{ notification: PiAgentNotification; time: Date | null }>;
};

const noSubagentReports: ChatExtensions["useSubagentReports"] = (notifications) =>
  notifications.map(() => null);

const ChatExtensionsContext = createContext<ChatExtensions>({
  agentLabel: "Pi",
  UserAttachments: null,
  WorkflowRun: null,
  ToolCallFollowUps: null,
  composerHeader: null,
  systemMessages: {},
  useSubagentReports: noSubagentReports,
  NotificationLine: NotificationEventLine,
});

/** `value` must keep its hooks between renders, as `useSubagentReports` is called as one. */
export function ChatExtensionsProvider({
  value,
  children,
}: {
  value: Partial<ChatExtensions>;
  children: ReactNode;
}) {
  const defaults = useContext(ChatExtensionsContext);
  return (
    <ChatExtensionsContext value={{ ...defaults, ...value }}>{children}</ChatExtensionsContext>
  );
}

export function useChatExtensions(): ChatExtensions {
  return useContext(ChatExtensionsContext);
}

/** An event delivered to the agent; expanding it shows the event's subject and payload. */
export function NotificationEventLine({
  notification,
  time,
}: {
  notification: PiAgentNotification;
  time: Date | null;
}) {
  return (
    <ChatEventDisclosure
      defaultOpen={false}
      marker="notification"
      title={`${notification.event.source} · ${notification.event.eventType}`}
      note={notification.routeId === null ? null : `via ${notification.routeId}`}
      time={time}
    >
      <NotificationEventDetails notification={notification} />
    </ChatEventDisclosure>
  );
}

/** How an event reached the agent, and its subject and payload. */
export function NotificationEventDetails({ notification }: { notification: PiAgentNotification }) {
  return (
    <>
      <p className="mb-2 text-[10px] text-[var(--bo-muted-2)]">
        Event {notification.event.id},{" "}
        {notification.routeId === null
          ? "addressed to this agent."
          : "delivered by an automation route."}
      </p>
      <pre className="overflow-x-auto text-xs leading-5 whitespace-pre-wrap text-[var(--bo-muted)]">
        {JSON.stringify(
          { subject: notification.event.subject, payload: notification.event.payload },
          null,
          2,
        )}
      </pre>
    </>
  );
}
