import { Filter } from "lucide-react";

import {
  CadenceGhostButton,
  CadencePageHeader,
  CadencePanel,
  StatTile,
  type Status,
  StatusBadge,
} from "@/components/cadence";

type Automation = {
  name: string;
  owner: string;
  status: Status;
  lastRun: string;
  runs: number;
  success: number; // 0..1
};

const AUTOMATIONS: Automation[] = [
  {
    name: "Support email triage",
    owner: "Customer team",
    status: "running",
    lastRun: "running now",
    runs: 1842,
    success: 0.991,
  },
  {
    name: "Stripe ↔ ledger reconciliation",
    owner: "Finance team",
    status: "succeeded",
    lastRun: "12 min ago",
    runs: 365,
    success: 1,
  },
  {
    name: "Customer onboarding",
    owner: "Growth team",
    status: "running",
    lastRun: "running now",
    runs: 5102,
    success: 0.974,
  },
  {
    name: "Deploy failure escalation",
    owner: "Platform team",
    status: "failed",
    lastRun: "4 min ago",
    runs: 88,
    success: 0.84,
  },
  {
    name: "Weekly board digest",
    owner: "Exec team",
    status: "deploying",
    lastRun: "deploying",
    runs: 24,
    success: 1,
  },
  {
    name: "Churn-risk early warning",
    owner: "Growth team",
    status: "paused",
    lastRun: "paused 2 days ago",
    runs: 410,
    success: 0.96,
  },
];

function SuccessMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.97 ? "var(--cad-verdigris)" : value >= 0.9 ? "var(--cad-brass)" : "var(--cad-rose)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 bg-[var(--cad-bg-2)]">
        <div className="h-full" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <span className="cad-mono text-xs text-[var(--cad-muted)] tabular-nums">{pct}%</span>
    </div>
  );
}

export default function OpsPage() {
  const running = AUTOMATIONS.filter((a) => a.status === "running").length;
  const deploying = AUTOMATIONS.filter((a) => a.status === "deploying").length;
  const failed = AUTOMATIONS.filter((a) => a.status === "failed").length;
  const runsToday = AUTOMATIONS.reduce((sum, a) => sum + a.runs, 0);

  return (
    <>
      <CadencePageHeader
        eyebrow="Operations"
        title="Automations"
        description="Every automation in this workspace, with its current status and recent reliability."
        actions={
          <CadenceGhostButton type="button">
            <Filter className="h-4 w-4" />
            Filter
          </CadenceGhostButton>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile value={running} label="Running" accent hint="Live right now" />
        <StatTile value={deploying} label="Deploying" hint="Rolling out changes" />
        <StatTile value={failed} label="Failing" hint="Needs attention" />
        <StatTile
          value={runsToday.toLocaleString()}
          label="Runs today"
          hint="Across all automations"
        />
      </div>

      <CadencePanel className="overflow-hidden">
        <div className="grid grid-cols-[1.6fr_0.9fr_1.1fr] items-center gap-4 border-b border-[color:var(--cad-line)] px-5 py-3 md:grid-cols-[1.6fr_0.8fr_0.9fr_1.1fr]">
          <span className="cad-eyebrow text-[var(--cad-muted-2)]">Automation</span>
          <span className="cad-eyebrow text-[var(--cad-muted-2)]">Status</span>
          <span className="cad-eyebrow hidden text-[var(--cad-muted-2)] md:block">Last run</span>
          <span className="cad-eyebrow text-right text-[var(--cad-muted-2)] md:text-left">
            Success
          </span>
        </div>

        <div className="divide-y divide-[color:var(--cad-line)]">
          {AUTOMATIONS.map((a) => (
            <div
              key={a.name}
              className="grid grid-cols-[1.6fr_0.9fr_1.1fr] items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--cad-panel-hover)] md:grid-cols-[1.6fr_0.8fr_0.9fr_1.1fr]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--cad-fg)]">{a.name}</p>
                <p className="cad-mono truncate text-xs text-[var(--cad-muted-2)]">
                  {a.owner} · {a.runs.toLocaleString()} runs
                </p>
              </div>
              <div>
                <StatusBadge status={a.status} />
              </div>
              <p className="cad-mono hidden text-xs text-[var(--cad-muted)] md:block">
                {a.lastRun}
              </p>
              <div className="flex justify-end md:justify-start">
                <SuccessMeter value={a.success} />
              </div>
            </div>
          ))}
        </div>
      </CadencePanel>
    </>
  );
}
