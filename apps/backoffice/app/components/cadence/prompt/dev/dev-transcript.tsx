/*
 * The dev terminal transcript: a scrolling log of past commands and their
 * output, styled like a terminal but in Cadence's light palette. Genuine
 * monospace (`font-mono`) signals the shift from the plain-language composer.
 *
 * Entries come straight from `useDashboardTerminal`, so the shapes match the
 * backoffice Pi terminal (cwd, exit code, duration).
 */

import { shortenDashboardCwd } from "@/routes/backoffice/dashboard-terminal";

import type { DevTerminalEntry } from "../prompt-context";

export function DevTranscript({
  entries,
  scrollRef,
}: {
  entries: readonly DevTerminalEntry[];
  scrollRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      className="cad-scroll min-h-0 max-w-full min-w-0 flex-1 overflow-auto pb-4 font-mono text-xs leading-6 text-[var(--cad-fg)]"
    >
      <div className="mx-auto w-full max-w-4xl px-5">
        {entries.map((entry) => (
          <div key={entry.id} className="mb-4 w-max min-w-full last:mb-0">
            <p className="text-[var(--cad-muted-2)]">
              [{new Date(entry.timestamp).toLocaleTimeString()}]
            </p>
            <p>
              <span className="text-[var(--cad-brass)]">{shortenDashboardCwd(entry.cwd, 44)}</span>
              <span className="text-[var(--cad-muted)]"> $ </span>
              <span className="text-[var(--cad-fg)]">{entry.command || "(system)"}</span>
            </p>
            <pre
              className={`whitespace-pre ${entry.ok ? "text-[var(--cad-muted)]" : "text-[var(--cad-rose)]"}`}
            >
              {entry.output}
            </pre>
            {entry.command ? (
              <p className="cad-eyebrow mt-1 text-[9px] text-[var(--cad-muted-2)]">
                exit {entry.exitCode} · {entry.durationMs}ms
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
