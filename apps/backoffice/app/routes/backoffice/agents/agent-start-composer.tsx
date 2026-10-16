import { Button } from "@fragno-private/design-system/button";
import { useState } from "react";
import { useFetcher } from "react-router";

import { formatPiAgentName } from "./agent-name";
import { AgentPermissions } from "./agent-permissions";

type AgentStartComposerProps = {
  agentName: string;
  description: string;
  permissions: readonly string[];
  /** Null when no organization can pay for this agent's first turn. */
  billingOrganization: { id: string; name: string } | null;
};

/** The first turn provisions the agent's conversation and, for personal agents, its billing owner. */
export function AgentStartComposer({
  agentName,
  description,
  permissions,
  billingOrganization,
}: AgentStartComposerProps) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [draftPrompt, setDraftPrompt] = useState("");
  const sending = fetcher.state !== "idle";
  const submissionDisabled = sending || !draftPrompt.trim() || billingOrganization === null;
  const sendError = fetcher.data && !fetcher.data.ok ? (fetcher.data.error ?? null) : null;
  const displayName = formatPiAgentName(agentName);

  return (
    <div className="backoffice-scroll h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-8 sm:px-8">
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] sm:text-2xl">
          {displayName}
        </h2>
        <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
        <AgentPermissions permissions={permissions} className="mt-2 mb-5 font-mono text-xs" />

        <fetcher.Form method="post" className="w-full">
          <input type="hidden" name="intent" value="start" />
          <div className="bo-input">
            <label
              htmlFor="agent-start-prompt"
              className="block px-4 pt-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase"
            >
              Message
            </label>
            <textarea
              id="agent-start-prompt"
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
              className="block min-h-28 w-full resize-none bg-transparent px-4 pt-2 pb-4 text-base leading-7 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] sm:min-h-32"
            />
          </div>

          <div className="gap-x-gutter mt-3 grid gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <p className="text-xs text-[var(--bo-muted)]">
              Billing organization: {billingOrganization?.name ?? "No active organization"}
            </p>
            <Button type="submit" variant="solid" disabled={submissionDisabled}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
          {sendError ? (
            <p className="mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-pretty text-[var(--bo-failed)]">
              {sendError}
            </p>
          ) : null}
        </fetcher.Form>
      </div>
    </div>
  );
}
