import { Button } from "@fragno-private/design-system/button";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
} from "@fragno-private/design-system/chat-start";
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import type { PiAvailableModel } from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import {
  AgentModelMenu,
  agentModelChoiceFormFields,
  defaultAgentModelChoice,
  type AgentModelChoice,
} from "./agent-model-menu";
import { AgentPermissions } from "./agent-permissions";

type AgentStartComposerProps = {
  /** The agent's detail route, which owns its actions. */
  action: string;
  agentName: string;
  /** Built-in agents start on the model the first message chooses. */
  builtIn: boolean;
  availableModelOptions: readonly PiAvailableModel[];
  description: string;
  permissions: readonly string[];
  usageLabel: string;
  /** Called once the first turn is accepted and the agent is provisioned. */
  onStarted: () => void;
};

/** The first turn provisions the agent's conversation. */
export function AgentStartComposer({
  action,
  agentName,
  builtIn,
  availableModelOptions,
  description,
  permissions,
  usageLabel,
  onStarted,
}: AgentStartComposerProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [pickedModel, setPickedModel] = useState<AgentModelChoice | null>(null);
  const model = builtIn ? (pickedModel ?? defaultAgentModelChoice(availableModelOptions)) : null;
  const [draftPrompt, setDraftPrompt] = useState("");
  const sending = fetcher.state !== "idle";
  const submissionDisabled = sending || !draftPrompt.trim();
  const sendError = fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null;
  const started = fetcher.data?.ok === true;
  const displayName = formatPiAgentName(agentName);

  useEffect(() => {
    if (started) {
      onStarted();
    }
  }, [started, onStarted]);

  return (
    <ChatStartPanel
      title={displayName}
      description={description}
      details={<AgentPermissions permissions={permissions} className="font-mono text-xs" />}
    >
      <fetcher.Form method="post" action={action} className="w-full">
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
