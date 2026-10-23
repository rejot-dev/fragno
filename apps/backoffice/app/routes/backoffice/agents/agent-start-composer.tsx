import { Button } from "@fragno-private/design-system/button";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
} from "@fragno-private/design-system/chat-start";
import { useState } from "react";
import { useFetcher, useOutletContext } from "react-router";

import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import {
  AgentModelMenu,
  agentModelChoiceFormFields,
  defaultAgentModelChoice,
  type AgentModelChoice,
} from "./agent-model-menu";
import { AgentPermissions } from "./agent-permissions";
import type { PiAgentsOutletContext } from "./agent-types";

type AgentStartComposerProps = {
  agentName: string;
  /** Built-in agents start on the model the first message chooses. */
  builtIn: boolean;
  description: string;
  permissions: readonly string[];
  usageLabel: string;
};

/** The first turn provisions the agent's conversation. */
export function AgentStartComposer({
  agentName,
  builtIn,
  description,
  permissions,
  usageLabel,
}: AgentStartComposerProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const { availableModelOptions } = useOutletContext<PiAgentsOutletContext>();
  const [pickedModel, setPickedModel] = useState<AgentModelChoice | null>(null);
  const model = builtIn ? (pickedModel ?? defaultAgentModelChoice(availableModelOptions)) : null;
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
        {model
          ? Object.entries(agentModelChoiceFormFields(model)).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))
          : null}
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
            <div className="flex items-center justify-end gap-2">
              {model ? (
                <AgentModelMenu
                  choice={model}
                  availableModels={availableModelOptions}
                  onChoose={setPickedModel}
                />
              ) : null}
              <Button type="submit" variant="solid" disabled={submissionDisabled}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          }
          alert={sendError}
        />
      </fetcher.Form>
    </ChatStartPanel>
  );
}
