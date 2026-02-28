import { Link } from "react-router";
import { BackofficePageHeader, FormContainer, WizardStepper } from "@/components/backoffice";

const STATS = [
  { label: "Active fragments", value: "14", delta: "+3 this week" },
  { label: "Review queue", value: "6", delta: "2 awaiting approval" },
  { label: "Docs health", value: "92%", delta: "Last audit 2h ago" },
];

const STEPS = [
  {
    title: "Define scope",
    description: "Confirm fragments, routes, and hooks to ship in the next release.",
    helper: "Owner: Release lead",
  },
  {
    title: "Review gating",
    description: "Check runtime adapters, security, and migration notes.",
    helper: "Owners: Platform + Security",
  },
  {
    title: "Publish window",
    description: "Schedule the deploy and notify framework teams.",
    helper: "Owner: Docs + Release",
  },
];

const REQUEST_TYPES = ["Release review", "Docs proof", "Schema diff", "Partner handoff"];

export function meta() {
  return [
    { title: "Backoffice Dashboard" },
    { name: "description", content: "Fragno backoffice overview dashboard." },
  ];
}

export default function BackofficeDashboard() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Overview" }]}
        eyebrow="Control"
        title="Release cadence, team health, and fragment governance."
        description="Track the pulse of the docs and fragment ecosystem across upcoming release windows."
        actions={
          <>
            <Link
              to="/backoffice/settings"
              className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
            >
              Update workspace
            </Link>
            <button
              type="button"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
            >
              Export snapshot
            </button>
          </>
        }
      />

      <section className="grid gap-3 lg:grid-cols-3">
        {STATS.map((stat) => (
          <div
            key={stat.label}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
          >
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              {stat.label}
            </p>
            <div className="mt-3 flex items-end justify-between">
              <p className="text-2xl font-semibold text-[var(--bo-fg)]">{stat.value}</p>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                {stat.delta}
              </span>
            </div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  Release ritual
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  Next publishing window
                </h2>
                <p className="mt-2 text-sm text-[var(--bo-muted)]">
                  The next coordinated release targets March 4, with platform QA in progress.
                </p>
              </div>
              <button
                type="button"
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                View checklist
              </button>
            </div>
            <div className="mt-4">
              <WizardStepper steps={STEPS} currentStep={1} />
            </div>
          </div>

          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  Activity
                </p>
                <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Recent approvals</h3>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                12 updates
              </span>
            </div>
            <div className="mt-4 space-y-2">
              {[
                "Workflows fragment migration cleared for staging",
                "Auth docs linked to new adapter checklist",
                "Stripe integration verified against v2.6 schema",
              ].map((item) => (
                <div
                  key={item}
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-muted)]"
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <FormContainer
            title="Quick request"
            eyebrow="Ops"
            description="Ask for a review, an environment refresh, or a fragment compliance check."
          >
            <div className="space-y-3">
              <label className="block space-y-2 text-sm">
                <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                  Request type
                </span>
                <div className="grid gap-2">
                  {REQUEST_TYPES.map((label, index) => (
                    <label
                      key={label}
                      className="flex items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-xs text-[var(--bo-muted)]"
                    >
                      <span>{label}</span>
                      <input
                        type="radio"
                        name="request-type"
                        value={label}
                        defaultChecked={index === 0}
                        className="h-4 w-4 accent-[var(--bo-accent)]"
                      />
                    </label>
                  ))}
                </div>
              </label>
              <label className="block space-y-2 text-sm">
                <span className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                  Notes
                </span>
                <textarea
                  rows={4}
                  placeholder="Add the key context, owners, and deadlines."
                  className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
                />
              </label>
              <button
                type="button"
                className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
              >
                Send request
              </button>
            </div>
          </FormContainer>

          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Signals
            </p>
            <h3 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Team bandwidth</h3>
            <div className="mt-3 space-y-2">
              {[
                { label: "Docs", status: "Focused", detail: "3 parallel reviews" },
                { label: "Platform", status: "Heavy", detail: "Auth adapter migration" },
                { label: "Design", status: "Light", detail: "UI refresh backlog" },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-semibold text-[var(--bo-fg)]">{item.label}</p>
                    <p className="text-xs text-[var(--bo-muted-2)]">{item.detail}</p>
                  </div>
                  <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                    {item.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
