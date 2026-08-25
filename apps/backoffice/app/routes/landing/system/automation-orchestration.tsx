import { GitBranch, Workflow, Zap } from "lucide-react";

const laneHeaderClassName = "flex min-h-14 items-center px-4 py-3";
const routeCardClassName =
  "min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 shadow-[var(--bo-panel-shadow)]";

export function AutomationOrchestration() {
  return (
    <section aria-labelledby="automation-orchestration-heading">
      <div className="grid gap-8 lg:grid-cols-[0.4fr_0.6fr] lg:items-end">
        <h2
          id="automation-orchestration-heading"
          className="max-w-md text-[clamp(2.25rem,4.4vw,4.25rem)] leading-[0.96] font-[560] tracking-[-0.055em] text-balance"
        >
          Event orchestration.
        </h2>
        <p className="max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)] lg:justify-self-end">
          Your business runs on "things happening": events. React to them automatically while still
          knowing exactly what happened, when, and why.
        </p>
      </div>

      <div className="mt-10 overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
        <div className="backoffice-scroll overflow-x-auto">
          <div className="min-w-[980px]">
            <div className="grid grid-cols-[17rem_minmax(22rem,1fr)_minmax(22rem,1fr)] gap-3 border-b border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3">
              <LaneHeader title="Sources" />
              <LaneHeader title="When" />
              <LaneHeader title="Then" />
            </div>

            <div className="grid grid-cols-[17rem_minmax(22rem,1fr)_minmax(22rem,1fr)] grid-rows-2 gap-3 p-3">
              <div className={`${routeCardClassName} row-span-2`}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center bg-lime-500/10 text-lime-700 dark:text-lime-300">
                    <GitBranch className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-[var(--bo-fg)]">GitHub</h3>
                    <p className="mt-1 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
                      Source
                    </p>
                  </div>
                </div>
              </div>

              <TriggerCard
                title="Review opened pull request"
                eventType="github.pull_request.opened"
                matcher='repository.full_name = "rejot-dev/fragno"'
                priority="P10"
              />
              <ActionCard
                kind="workflow"
                title="pull-request-review.workflow.js"
                action="Start workflow"
                detail="event payload becomes workflow input"
              />

              <TriggerCard
                title="Forward main branch push"
                eventType="github.push"
                matcher='ref = "refs/heads/main"'
                priority="P20"
              />
              <ActionCard
                kind="forward"
                title="ReJot Docs"
                action="Forward event"
                detail="project · rejot-dev:docs"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LaneHeader({ title }: { title: string }) {
  return (
    <div className={laneHeaderClassName}>
      <p className="text-lg font-semibold text-[var(--bo-fg)]">{title}</p>
    </div>
  );
}

function TriggerCard({
  title,
  eventType,
  matcher,
  priority,
}: {
  title: string;
  eventType: string;
  matcher: string;
  priority: string;
}) {
  return (
    <article className={routeCardClassName}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center bg-orange-500/10 text-orange-700 dark:text-orange-300">
            <Zap className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-[var(--bo-fg)]">{title}</h3>
            <p className="mt-1 text-[9px] font-semibold tracking-[0.18em] text-orange-700 uppercase dark:text-orange-300">
              Trigger
            </p>
          </div>
        </div>
        <span className="font-mono text-[10px] text-[var(--bo-muted-2)]">{priority}</span>
      </div>
      <div className="mt-4 space-y-2 border-t border-[color:var(--bo-border)] pt-3 font-mono">
        <p className="text-[11px] text-[var(--bo-fg)]">{eventType}</p>
        <p className="text-[10px] text-[var(--bo-muted-2)]">{matcher}</p>
      </div>
    </article>
  );
}

function ActionCard({
  kind,
  title,
  action,
  detail,
}: {
  kind: "workflow" | "forward";
  title: string;
  action: string;
  detail: string;
}) {
  const icon =
    kind === "workflow" ? (
      <Workflow className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
    ) : (
      <GitBranch className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
    );
  const iconClassName =
    kind === "workflow"
      ? "bg-rose-950/8 text-rose-950 dark:bg-rose-300/10 dark:text-rose-200"
      : "bg-violet-500/10 text-violet-700 dark:text-violet-300";
  const actionClassName =
    kind === "workflow"
      ? "text-rose-700 dark:text-rose-300"
      : "text-violet-700 dark:text-violet-300";

  return (
    <article className={routeCardClassName}>
      <div className="flex items-start gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center ${iconClassName}`}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-[var(--bo-fg)]">{title}</h3>
          <p
            className={`mt-1 text-[9px] font-semibold tracking-[0.18em] uppercase ${actionClassName}`}
          >
            {action}
          </p>
        </div>
      </div>
      <p className="mt-4 border-t border-[color:var(--bo-border)] pt-3 font-mono text-[10px] text-[var(--bo-muted-2)]">
        {detail}
      </p>
    </article>
  );
}
