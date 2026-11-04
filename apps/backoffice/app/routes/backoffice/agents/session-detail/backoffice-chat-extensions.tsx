import type { CodemodeRun } from "@fragno-dev/backoffice-api/v0/pi-conversation/codemode-result";
import type { PiAgentAttachment } from "@fragno-dev/backoffice-api/v0/pi-conversation/prompt-attachments";
import type { ChatExtensions } from "@fragno-private/backoffice-chat/extensions";
import { ChatMessageAttachments } from "@fragno-private/design-system/agents/chat-attachment";

import { useFileScope } from "@/components/backoffice/file-scope";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";

import { sentAttachmentItems } from "../agent-attachments";
import {
  SubagentBatchMessage,
  SubagentsAtWork,
  ToolCallSubagents,
  useSubagentReports,
} from "../agent-subagent-batches";
import { NotificationLine } from "./notification-line";
import { SessionWorkflow, SessionWorkflowInputRequests } from "./session-workflow";

/** The files a message carried, from the scope the conversation's files are in. */
function SentAttachments({ attachments }: { attachments: readonly PiAgentAttachment[] }) {
  const scope = useFileScope();
  return scope === null ? null : (
    <ChatMessageAttachments attachments={sentAttachmentItems(scope, attachments)} />
  );
}

function CodemodeWorkflowRun({ run }: { run: CodemodeRun }) {
  return <SessionWorkflow run={{ workflowName: CODEMODE_WORKFLOW, instanceId: run.instanceId }} />;
}

/** The chat in Backoffice: the scope's files, the agent's workflow runs, and its subagents. */
export const backofficeChatExtensions: Partial<ChatExtensions> = {
  UserAttachments: SentAttachments,
  WorkflowRun: CodemodeWorkflowRun,
  ToolCallFollowUps: ToolCallSubagents,
  composerHeader: (
    <>
      <SubagentsAtWork />
      <SessionWorkflowInputRequests />
    </>
  ),
  systemMessages: { subagents: SubagentBatchMessage },
  useSubagentReports,
  NotificationLine,
};
