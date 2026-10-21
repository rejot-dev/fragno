import { Button } from "@fragno-private/design-system/button";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
} from "@fragno-private/design-system/chat-start";
import { useState } from "react";
import { useFetcher } from "react-router";

import { formatPiAgentName } from "./agent-name";
import { AgentPermissions } from "./agent-permissions";

type AgentStartComposerProps = {
  agentName: string;
  description: string;
  permissions: readonly string[];
  usageLabel: string;
};

/** The first turn provisions the agent's conversation. */
export function AgentStartComposer({
  agentName,
  description,
  permissions,
  usageLabel,
}: AgentStartComposerProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [draftPrompt, setDraftPrompt] = useState("");
  const sending = fetcher.state !== "idle";
  const submissionDisabled = sending || !draftPrompt.trim();
  const sendError = fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null;
  const displayName = formatPiAgentName(agentName);

  return (
    <ChatStartPanel
      title={displayName}
      description={description}
      details={<AgentPermissions permissions={permissions} className="font-mono text-xs" />}
    >
      <fetcher.Form method="post" className="w-full">
        <input type="hidden" name="intent" value="start" />
        <ChatPromptField
          id="agent-start-prompt"
          label="Message"
          name="content"
          required
          autoFocus
          rows={3}
          value={draftPrompt}
          onChange={(event) => {
            setDraftPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              submissionDisabled
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder={`Message ${displayName}`}
        />
        <ChatStartFooter
          note={usageLabel}
          action={
            <Button type="submit" variant="solid" disabled={submissionDisabled}>
              {sending ? "Sending…" : "Send"}
            </Button>
          }
          alert={sendError}
        />
      </fetcher.Form>
    </ChatStartPanel>
  );
}
