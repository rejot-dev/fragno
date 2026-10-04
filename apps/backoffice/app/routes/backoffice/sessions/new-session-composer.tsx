import { Button } from "@fragno-private/design-system/button";
import { Select } from "@fragno-private/design-system/select";
import { useState } from "react";
import { Form, Link } from "react-router";

import type { PiAvailableModel, PiManagerSession } from "@/fragno/pi-manager/pi-agent-contract";

import { formatTimestamp } from "./formatting";

const INITIAL_HISTORY_COUNT = 2;

type NewSessionComposerProps = {
  availableModelOptions: PiAvailableModel[];
  basePath: string;
  billingOrganization?: { id: string; name: string } | null;
  createError: string | null;
  creating: boolean;
  draftPrompt: string;
  selectedModelOption: string;
  listingError: string | null;
  sessions: PiManagerSession[];
  onDraftPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
};

export function NewSessionComposer({
  availableModelOptions,
  basePath,
  billingOrganization,
  createError,
  creating,
  draftPrompt,
  selectedModelOption,
  listingError,
  sessions,
  onDraftPromptChange,
  onModelChange,
}: NewSessionComposerProps) {
  const [historyOpen, setHistoryOpen] = useState(true);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const visibleSessions = showAllHistory ? sessions : sessions.slice(0, INITIAL_HISTORY_COUNT);
  const submissionDisabled =
    creating ||
    !draftPrompt.trim() ||
    availableModelOptions.length === 0 ||
    billingOrganization === null;

  return (
    <div className="backoffice-scroll h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-8 sm:px-8">
        <h2 className="mb-5 text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] sm:text-2xl">
          New session
        </h2>

        {availableModelOptions.length === 0 ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-pretty text-[var(--bo-muted)]">
            Sorry, no models are available for you to start a session with. Please check back later.
          </div>
        ) : (
          <Form method="post" action={basePath} className="w-full">
            <input type="hidden" name="intent" value="create-session" />
            <div className="bo-input">
              <label
                htmlFor="new-session-prompt"
                className="block px-4 pt-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase"
              >
                Message
              </label>
              <textarea
                id="new-session-prompt"
                name="prompt"
                required
                autoFocus
                rows={3}
                value={draftPrompt}
                onChange={(event) => {
                  onDraftPromptChange(event.target.value);
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
                placeholder="Message Pi"
                className="block min-h-28 w-full resize-none bg-transparent px-4 pt-2 pb-4 text-base leading-7 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] sm:min-h-32"
              />
            </div>

            <div className="gap-x-gutter mt-3 grid gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Select
                label="Model"
                name="modelOption"
                options={availableModelOptions.map((option) => ({
                  value: `${option.provider}::${option.modelId}`,
                  label: option.label,
                  description: option.provider.toUpperCase(),
                }))}
                placeholder="No model available"
                value={selectedModelOption}
                onValueChange={onModelChange}
              />
              {billingOrganization !== undefined ? (
                <p className="text-xs text-[var(--bo-muted)] sm:col-start-1 sm:row-start-2">
                  Billing organization: {billingOrganization?.name ?? "No active organization"}
                </p>
              ) : null}

              <Button
                type="submit"
                variant="solid"
                className="sm:col-start-2 sm:row-start-1 sm:self-end"
                disabled={submissionDisabled}
              >
                {creating ? "Sending…" : "Send"}
              </Button>
            </div>
            {createError ? (
              <p className="mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-pretty text-[var(--bo-failed)]">
                {createError}
              </p>
            ) : null}
          </Form>
        )}

        <section className="mt-8 border-t border-[color:var(--bo-border)] pt-3">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen((open) => !open);
            }}
            className="flex min-h-10 w-full items-center justify-between gap-4 text-left text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase hover:text-[var(--bo-fg)]"
          >
            <span>History</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{sessions.length}</span>
              <span aria-hidden="true">{historyOpen ? "−" : "+"}</span>
            </span>
          </button>

          {historyOpen ? (
            <div className="pt-1">
              {listingError ? (
                <p className="mb-2 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-xs text-pretty text-[var(--bo-failed)]">
                  {listingError}
                </p>
              ) : null}

              {sessions.length === 0 ? (
                <p className="py-5 text-sm text-[var(--bo-muted-2)]">No previous sessions</p>
              ) : (
                <div className="divide-y divide-[color:var(--bo-border)]">
                  {visibleSessions.map((session) => (
                    <Link
                      key={session.sessionId}
                      to={`${basePath}/${encodeURIComponent(session.sessionId)}`}
                      preventScrollReset
                      className="group flex min-h-14 items-center justify-between gap-4 px-1 py-3 transition-colors hover:bg-[rgba(var(--bo-grid),0.12)] sm:px-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--bo-fg)]">
                          {session.name || session.sessionId}
                        </p>
                        <time className="mt-1 block text-[10px] text-[var(--bo-muted-2)] tabular-nums">
                          {formatTimestamp(session.createdAt)}
                        </time>
                      </div>
                      <span
                        role="img"
                        aria-label="durable"
                        className="size-1.5 flex-none rounded-full bg-[var(--bo-live)]"
                      />
                    </Link>
                  ))}
                </div>
              )}

              {sessions.length > INITIAL_HISTORY_COUNT ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowAllHistory((showAll) => !showAll);
                  }}
                  className="mt-2"
                >
                  {showAllHistory
                    ? "Show less"
                    : `Show ${sessions.length - INITIAL_HISTORY_COUNT} more`}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
