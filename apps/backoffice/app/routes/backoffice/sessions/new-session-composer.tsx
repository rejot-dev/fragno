import { Form } from "react-router";

import type { PiHarnessConfig, PiModelOption } from "@/fragno/pi/pi-shared";

import { SessionSelect } from "./session-select";

const tapScale =
  "transition-transform duration-150 ease-out active:not-disabled:scale-[0.96] disabled:active:scale-100";

type NewSessionComposerProps = {
  availableModelOptions: PiModelOption[];
  basePath: string;
  createError: string | null;
  creating: boolean;
  draftPrompt: string;
  harnesses: PiHarnessConfig[];
  selectedHarnessId: string;
  selectedModelOption: string;
  onDraftPromptChange: (value: string) => void;
  onHarnessChange: (value: string) => void;
  onModelChange: (value: string) => void;
};

export function NewSessionComposer({
  availableModelOptions,
  basePath,
  createError,
  creating,
  draftPrompt,
  harnesses,
  selectedHarnessId,
  selectedModelOption,
  onDraftPromptChange,
  onHarnessChange,
  onModelChange,
}: NewSessionComposerProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-4 py-6 sm:px-8">
      <h2 className="mb-5 text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] sm:text-2xl">
        New session
      </h2>

      {harnesses.length === 0 ? (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-pretty text-[var(--bo-muted)]">
          Configure a harness in Internals → Pi.
        </div>
      ) : (
        <Form method="post" action={basePath} className="w-full">
          <input type="hidden" name="intent" value="create-session" />
          <div className="border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] focus-within:border-[color:var(--bo-accent)] focus-within:ring-2 focus-within:ring-[color:var(--bo-accent)]/15">
            <label
              htmlFor="new-session-prompt"
              className="block px-4 pt-3 font-mono text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase"
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
                  creating
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

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <SessionSelect
              label="Model"
              name="modelOption"
              options={availableModelOptions.map((option) => ({
                value: `${option.provider}::${option.name}`,
                label: option.label,
                description: option.provider.toUpperCase(),
              }))}
              placeholder="No model available"
              value={selectedModelOption}
              onValueChange={onModelChange}
            />

            <SessionSelect
              label="Harness"
              name="harnessId"
              options={harnesses.map((harness) => ({
                value: harness.id,
                label: harness.label,
                description: `${harness.tools.length} ${harness.tools.length === 1 ? "tool" : "tools"}`,
              }))}
              placeholder="Select harness"
              value={selectedHarnessId}
              onValueChange={onHarnessChange}
            />

            <button
              type="submit"
              disabled={creating || !draftPrompt.trim() || availableModelOptions.length === 0}
              className={`min-h-11 bg-[var(--bo-accent)] px-6 text-xs font-semibold text-white transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--bo-accent-strong)] disabled:cursor-not-allowed disabled:opacity-35 ${tapScale}`}
            >
              {creating ? "Sending…" : "Send"}
            </button>
          </div>
          {createError ? (
            <p className="mt-3 border border-[color:var(--bo-failed)] bg-[var(--bo-failed-bg)] px-3 py-2 text-sm text-pretty text-[var(--bo-failed)]">
              {createError}
            </p>
          ) : null}
        </Form>
      )}
    </div>
  );
}
