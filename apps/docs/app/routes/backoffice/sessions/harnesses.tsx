import { useOutletContext } from "react-router";

import { resolvePiHarnesses } from "@/fragno/pi-shared";

import type { PiLayoutContext } from "./shared";

export default function BackofficeOrganisationPiHarnesses() {
  const { configState, configLoading, configError } = useOutletContext<PiLayoutContext>();
  const harnesses = resolvePiHarnesses(configState?.config?.harnesses);

  if (configLoading) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        Loading harnesses…
      </div>
    );
  }

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (harnesses.length === 0) {
    return (
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        No harnesses configured yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
          Harnesses
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
          Read-only harness catalog
        </h2>
        <p className="mt-2 text-sm text-[var(--bo-muted)]">
          Harnesses define the system prompt and toolset for Pi sessions. Configuration is managed
          outside the backoffice.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {harnesses.map((harness) => (
          <div
            key={harness.id}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                  {harness.id}
                </p>
                <h3 className="mt-2 text-lg font-semibold text-[var(--bo-fg)]">{harness.label}</h3>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                {harness.tools.length} tools
              </span>
            </div>

            {harness.description ? (
              <p className="mt-2 text-sm text-[var(--bo-muted)]">{harness.description}</p>
            ) : null}

            <div className="mt-4 space-y-2 text-xs text-[var(--bo-muted)]">
              <p>
                <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Thinking level
                </span>
                <span className="ml-2 text-[var(--bo-fg)]">
                  {harness.thinkingLevel ?? "default"}
                </span>
              </p>
              <p>
                <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Steering mode
                </span>
                <span className="ml-2 text-[var(--bo-fg)]">
                  {harness.steeringMode ?? "one-at-a-time"}
                </span>
              </p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {harness.tools.map((tool) => (
                <span
                  key={tool}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] tracking-[0.22em] text-[var(--bo-muted)] uppercase"
                >
                  {tool}
                </span>
              ))}
            </div>

            <div className="mt-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-2 text-xs text-[var(--bo-muted)]">
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                System prompt
              </p>
              <p className="mt-1 text-[11px] whitespace-pre-wrap text-[var(--bo-fg)]">
                {harness.systemPrompt}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
