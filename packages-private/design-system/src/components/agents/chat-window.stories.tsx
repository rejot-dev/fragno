import type { ReactNode } from "react";

import { Button } from "../controls/button";
import { OperationNotice } from "../feedback/operation-notice";
import { PaneMessage, PaneSpinner } from "../feedback/pane-message";
import { ChatPromptField, ChatStartFooter, ChatStartPanel } from "./chat-start";
import { SampleComposer, SampleConversation } from "./chat-story-support";
import {
  ChatColumn,
  ChatHistoryControls,
  ChatScrollToLatestButton,
  ChatThread,
  ChatThreadNotice,
  ChatTurnSpacer,
  ChatViewport,
  ChatViewportFooter,
} from "./chat-thread";

export default { title: "Agents/Chat window" };

// The pane a chat window fills in Backoffice, below the page's tab header.
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[46rem] flex-col overflow-hidden border border-[color:var(--bo-border)]">
      {children}
    </div>
  );
}

export function Conversation() {
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <ChatHistoryControls
              explanation={null}
              hasMore
              loading={false}
              error={null}
              onLoadMore={() => undefined}
              onRetry={null}
            />
            <SampleConversation />
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert={null}>
            <SampleComposer running={false} disabled={null} queue={[]} />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

export function Running() {
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <SampleConversation />
            <ChatThreadNotice>
              <OperationNotice
                tone="progress"
                title="Compacting context"
                description="Selecting history and writing a durable summary…"
              />
            </ChatThreadNotice>
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert={null}>
            <ChatScrollToLatestButton onClick={() => undefined} />
            <SampleComposer
              running
              disabled={null}
              queue={[
                { label: "Steering", text: "Skip Acme, they paid this morning." },
                { label: "Up next", text: "Then summarize this week's revenue." },
              ]}
            />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

export function Failed() {
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <ChatHistoryControls
              explanation="Earlier messages are still visible but out of context for the agent due to compaction."
              hasMore
              loading={false}
              error="Pi history request failed with status 502."
              onLoadMore={() => undefined}
              onRetry={() => undefined}
            />
            <ChatThreadNotice>
              <OperationNotice
                tone="failed"
                title="Context compaction failed"
                description="The summary model did not respond."
                onRetry={() => undefined}
              />
            </ChatThreadNotice>
            <ChatTurnSpacer />
          </ChatColumn>
          <ChatViewportFooter alert="Write a message before sending.">
            <SampleComposer
              running={false}
              disabled={{ reason: "This agent is read-only for you", paused: false }}
              queue={[]}
            />
          </ChatViewportFooter>
        </ChatViewport>
      </ChatThread>
    </Frame>
  );
}

export function Loading() {
  return (
    <Frame>
      <PaneSpinner label="Loading conversation" />
    </Frame>
  );
}

export function Unavailable() {
  return (
    <Frame>
      <PaneMessage tone="failed">Invoice Agent is not an agent in this scope.</PaneMessage>
    </Frame>
  );
}

export function Start() {
  return (
    <Frame>
      <ChatStartPanel
        title="Invoice Agent"
        description="Chases unpaid invoices and drafts reminders for overdue customers."
        details={
          <p className="font-mono text-xs">
            <span className="text-[var(--bo-muted-2)]">Permissions: </span>
            <span className="text-[var(--bo-fg)]">invoices.read, email.draft</span>
          </p>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <ChatPromptField
            id="story-start-prompt"
            label="Message"
            rows={3}
            placeholder="Message Invoice Agent"
          />
          <ChatStartFooter
            note="Billing organization: Acme Bookkeeping"
            action={
              <Button type="submit" variant="solid">
                Send
              </Button>
            }
            alert={null}
          />
        </form>
      </ChatStartPanel>
    </Frame>
  );
}
