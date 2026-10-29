import { Icon } from "../icon";
import { BackofficeStatusLight } from "../status-light";
import { TerminalLog, TerminalLogEntry } from "../terminal";
import { LandingSection } from "./landing-section";

const SANDBOX_FACTS = [
  { label: "Image", value: "Workspace", detail: "Node.js, Python, git, ripgrep, jq" },
  { label: "Size", value: "standard-2", detail: null },
  { label: "Sleeps after", value: "15 minutes idle", detail: "Files are kept" },
] as const;

const SESSION = [
  {
    command: "git clone https://github.com/harbor/reports && cd reports",
    output: "Cloning into 'reports'...",
    durationMs: 2140,
  },
  {
    command: "python3 build_report.py --month 2026-10",
    output: "Read 18,402 orders\nWrote out/october.pdf (14 pages)",
    durationMs: 9310,
  },
  {
    command: "ls -lh out",
    output: "-rw-r--r-- 1 user user 412K Oct 28 09:41 october.pdf",
    durationMs: 18,
  },
] as const;

/** Shows a running sandbox and its console: a real machine for jobs too heavy for a workflow. */
export function LandingComputers() {
  return (
    <LandingSection
      id="landing-computers"
      title="A computer when the job needs one."
      visual={
        <div className="grid border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)] lg:grid-cols-[0.34fr_0.66fr]">
          <div className="border-b border-[color:var(--bo-border)] p-5 lg:border-r lg:border-b-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center bg-[var(--bo-panel-2)] text-[var(--bo-muted)]">
                  <Icon name="monitor" className="size-4" strokeWidth={1.8} />
                </span>
                <div>
                  <h3 className="text-sm font-semibold">monthly-reports</h3>
                  <p className="text-[11px] text-[var(--bo-muted-2)]">Harbor Booking</p>
                </div>
              </div>
              <BackofficeStatusLight tone="live">Running</BackofficeStatusLight>
            </div>
            <dl className="mt-6 divide-y divide-[color:var(--bo-border)] border-y border-[color:var(--bo-border)]">
              {SANDBOX_FACTS.map((fact) => (
                <div key={fact.label} className="py-3">
                  <dt className="text-[11px] text-[var(--bo-muted-2)]">{fact.label}</dt>
                  <dd className="mt-0.5 text-sm">{fact.value}</dd>
                  {fact.detail ? (
                    <dd className="text-[11px] text-[var(--bo-muted)]">{fact.detail}</dd>
                  ) : null}
                </div>
              ))}
            </dl>
          </div>

          <div className="flex min-h-[300px] min-w-0 flex-col">
            <TerminalLog ref={null}>
              {SESSION.map((entry, index) => (
                <TerminalLogEntry
                  key={entry.command}
                  timestamp={new Date(Date.UTC(2026, 9, 28, 9, 38 + index)).toISOString()}
                  cwd={index === 0 ? "/workspace" : "/workspace/reports"}
                  command={entry.command}
                  output={entry.output}
                  ok
                  exitCode={0}
                  durationMs={entry.durationMs}
                />
              ))}
            </TerminalLog>
          </div>
        </div>
      }
    >
      Start a Linux sandbox for work that needs a real machine: builds, scripts, and data jobs.
      Agents and workflows run commands on it like you do. It sleeps when idle and keeps its files
      for next time.
    </LandingSection>
  );
}
