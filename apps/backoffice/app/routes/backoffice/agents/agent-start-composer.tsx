import { Button } from "@fragno-private/design-system/button";
import {
  ChatAttachmentDropZone,
  ChatComposerAttachButton,
  ChatComposerAttachments,
} from "@fragno-private/design-system/chat-attachment";
import {
  ChatPromptField,
  ChatStartFooter,
  ChatStartPanel,
} from "@fragno-private/design-system/chat-start";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";

import type { BackofficeResolvedScope } from "@/backoffice-runtime/resolved-scope";
import type { PiAvailableModel } from "@/fragno/pi/agent/pi-agent-contract";
import { formatPiAgentName } from "@/fragno/pi/agent/pi-agent-name";

import { agentAttachmentTarget, useAgentAttachments } from "./agent-attachments";
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
  /** Where the files the first message carries are uploaded. */
  resolvedScope: BackofficeResolvedScope;
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
  resolvedScope,
  onStarted,
}: AgentStartComposerProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [pickedModel, setPickedModel] = useState<AgentModelChoice | null>(null);
  const model = builtIn ? (pickedModel ?? defaultAgentModelChoice(availableModelOptions)) : null;
  const [draftPrompt, setDraftPrompt] = useState("");
  const attachments = useAgentAttachments(
    useMemo(
      () => agentAttachmentTarget(resolvedScope, agentName, permissions),
      [resolvedScope, agentName, permissions],
    ),
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attached = (attachments?.items.length ?? 0) > 0;
  const sending = fetcher.state !== "idle" || attachments?.sending === true;
  const submissionDisabled = sending || (!draftPrompt.trim() && !attached);
  const sendError =
    attachments?.refusal ??
    attachmentError ??
    (fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null);
  const started = fetcher.data?.ok === true;
  const displayName = formatPiAgentName(agentName);

  useEffect(() => {
    if (started) {
      onStarted();
    }
  }, [started, onStarted]);

  return (
    <ChatAttachmentDropZone
      disabled={attachments === null || sending}
      onFiles={(files) => {
        attachments?.add(files);
      }}
    >
      <ChatStartPanel
        title={displayName}
        description={description}
        details={<AgentPermissions permissions={permissions} className="font-mono text-xs" />}
      >
        <form
          className="w-full"
          onSubmit={(event) => {
            event.preventDefault();
            const formData = new FormData(event.currentTarget);
            // The message waits for the files it carries to upload, then goes with those that did.
            void (async () => {
              setAttachmentError(null);
              const files = attachments === null ? null : await attachments.take();
              if (files !== null && files.failed.length > 0) {
                setAttachmentError(
                  `Not attached, because the upload failed: ${files.failed.join(", ")}.`,
                );
              }
              const locations = files?.locations ?? [];
              if (!draftPrompt.trim() && locations.length === 0) {
                return;
              }
              if (locations.length > 0) {
                formData.set("attachments", JSON.stringify(locations));
              }
              await fetcher.submit(formData, { method: "post", action });
            })();
          }}
        >
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
            required={!attached}
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
          {attachments === null ? null : (
            <div className="mt-2">
              <ChatComposerAttachments attachments={attachments.items} />
            </div>
          )}
          <ChatStartFooter
            note={usageLabel}
            action={
              <div className="flex items-center justify-end gap-2">
                {attachments === null ? null : (
                  <ChatComposerAttachButton disabled={sending} onFiles={attachments.add} />
                )}
                {model ? (
                  <AgentModelMenu
                    choice={model}
                    availableModels={availableModelOptions}
                    onChoose={setPickedModel}
                  />
                ) : null}
                <Button type="submit" variant="solid" disabled={submissionDisabled}>
                  {attachments?.sending ? "Uploading…" : sending ? "Sending…" : "Send"}
                </Button>
              </div>
            }
            alert={sendError}
          />
        </form>
      </ChatStartPanel>
    </ChatAttachmentDropZone>
  );
}
