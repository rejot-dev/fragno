import { useState, type ReactNode } from "react";

import { Button } from "./button";
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
import { ChatWorkspacePanel, ChatWorkspaceStatus } from "./chat-workspace-panel";
import { ChatWorkspaceSplit } from "./chat-workspace-split";
import { OperationNotice } from "./operation-notice";
import { PaneMessage } from "./pane-message";
import { UnderlineToggleButton } from "./underline-tabs";

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
  const [workflowShown, setWorkflowShown] = useState(true);
  const [display, setDisplay] = useState<"ui" | "simple" | "code">("simple");

  return (
    <Frame>
      <ChatWorkspaceSplit
        storageKey="storybook:chat-window"
        conversation={
          <ChatThread>
            <ChatViewport>
              <ChatColumn>
                <ChatHistoryControls
                  explanation={null}
                  hasMore
                  loading={false}
                  error={null}
                  onLoadMore={() => undefined}
                />
                <SampleConversation
                  workflowShown={workflowShown}
                  onToggleWorkflow={() => {
                    setWorkflowShown((current) => !current);
                  }}
                />
                <ChatTurnSpacer />
              </ChatColumn>
              <ChatViewportFooter alert={null}>
                <SampleComposer running={false} disabledReason={null} queue={[]} />
              </ChatViewportFooter>
            </ChatViewport>
          </ChatThread>
        }
        workspace={
          workflowShown ? (
            <ChatWorkspacePanel
              label="Unpaid invoices"
              toolbarRef={() => undefined}
              onClose={() => {
                setWorkflowShown(false);
              }}
              actions={
                <div role="group" aria-label="Workflow display" className="flex items-center gap-1">
                  {(["ui", "simple", "code"] as const).map((mode) => (
                    <UnderlineToggleButton
                      key={mode}
                      pressed={display === mode}
                      onClick={() => {
                        setDisplay(mode);
                      }}
                    >
                      {mode === "ui" ? "UI" : mode === "simple" ? "Flow" : "Code"}
                    </UnderlineToggleButton>
                  ))}
                </div>
              }
            >
              <ChatWorkspaceStatus tone="loading">Synchronizing workflow…</ChatWorkspaceStatus>
              <div className="flex h-full items-center justify-center text-xs text-[var(--bo-muted-2)]">
                The workflow graph renders here.
              </div>
            </ChatWorkspacePanel>
          ) : null
        }
      />
    </Frame>
  );
}

export function Running() {
  return (
    <Frame>
      <ChatThread>
        <ChatViewport>
          <ChatColumn>
            <SampleConversation workflowShown={false} onToggleWorkflow={() => undefined} />
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
              disabledReason={null}
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
              disabledReason="This agent is read-only for you"
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
      <PaneMessage tone="muted">Loading conversation…</PaneMessage>
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
