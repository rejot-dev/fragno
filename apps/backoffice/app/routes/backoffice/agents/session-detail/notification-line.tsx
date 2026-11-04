import type { PiAgentNotification } from "@fragno-dev/backoffice-api/v0/pi-conversation/notification-entry";
import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { NotificationEventDetails } from "@fragno-private/backoffice-chat/extensions";
import { ResultContent } from "@fragno-private/backoffice-chat/tools/result-content";
import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import {
  ChatEventDisclosure,
  ChatEventLink,
} from "@fragno-private/design-system/agents/chat-divider";

import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { FileScopeProvider } from "@/components/backoffice/file-scope";
import { workflowCompletionFromNotification } from "@/fragno/automation/workflow-reply";

import { useSessionRun } from "./session-workflow";

/**
 * An event delivered to the agent; expanding it shows the event's subject and payload. A
 * workflow's completion opens on its output when the output is an interface.
 */
export function NotificationLine({
  notification,
  time,
}: {
  notification: PiAgentNotification;
  time: Date | null;
}) {
  const { resolvedScope, resolveScope } = useCurrentBackofficeContext();
  const agentScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const completion = workflowCompletionFromNotification(notification.event, agentScope);
  // The conversation's runs are the agent's scope's; a run elsewhere may share an instance ID.
  const local = completion !== null && backofficeContextScopesEqual(completion.scope, agentScope);
  const run = useSessionRun(local ? completion.instanceId : null);
  const completionUi = completion === null ? null : parseBackofficeUiResult(completion.output);
  const output =
    completion !== null && completionUi !== null && completionUi.kind !== "ordinary"
      ? {
          parsed: completionUi,
          value: completion.output,
          // The run's files are in the scope it ran in.
          fileScope: resolveScope(completion.scope),
        }
      : null;
  const title = `${notification.event.source} · ${notification.event.eventType}`;

  // The run's card above holds its output, so the event leads back to it rather than repeat it.
  if (completion !== null && run !== null) {
    return (
      <ChatEventLink
        marker="live"
        title={title}
        note={completion.workflowName}
        time={time}
        action={output === null ? "View run" : "View result"}
        onShow={run.show}
      />
    );
  }

  return (
    <ChatEventDisclosure
      defaultOpen={output !== null}
      marker="notification"
      title={title}
      note={
        completion !== null
          ? completion.workflowName
          : notification.routeId === null
            ? null
            : `via ${notification.routeId}`
      }
      time={time}
    >
      {output !== null ? (
        <FileScopeProvider scope={output.fileScope}>
          <ResultContent parsedValue={output.parsed} showRawValue={false} value={output.value}>
            {null}
          </ResultContent>
        </FileScopeProvider>
      ) : (
        <NotificationEventDetails notification={notification} />
      )}
    </ChatEventDisclosure>
  );
}
