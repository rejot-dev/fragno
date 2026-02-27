import { BackofficePageHeader, FormContainer, FormField } from "@/components/backoffice";

export function meta() {
  return [
    { title: "Backoffice Settings" },
    { name: "description", content: "Configure backoffice workspace settings." },
  ];
}

export default function BackofficeSettings() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Settings" }]}
        eyebrow="Workspace"
        title="Define your operational defaults and review cadence."
        description="Align docs governance with your fragment release process."
      />

      <FormContainer
        title="Workspace defaults"
        description="Set the reporting cadence and communication settings for reviewers."
        eyebrow="Preferences"
        actions={
          <button
            type="button"
            className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
          >
            Save updates
          </button>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Workspace name" hint="Visible to all collaborators.">
            <input
              type="text"
              defaultValue="Fragno Backoffice"
              className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
            />
          </FormField>
          <FormField label="Primary reviewer" hint="Owner for release sign-off.">
            <input
              type="text"
              defaultValue="Aly Morgan"
              className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
            />
          </FormField>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Release cadence" hint="How often should docs and fragments sync?">
            <select
              defaultValue="Biweekly"
              className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
            >
              <option>Weekly</option>
              <option>Biweekly</option>
              <option>Monthly</option>
            </select>
          </FormField>
          <FormField label="Status digest" hint="Where should summaries be delivered?">
            <input
              type="email"
              defaultValue="ops@fragno.dev"
              className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
            />
          </FormField>
        </div>
        <FormField label="Release focus" hint="Short note shown on the dashboard header.">
          <textarea
            rows={3}
            defaultValue="Q1 release readiness for auth, workflows, and Stripe fragments."
            className="focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2"
          />
        </FormField>
      </FormContainer>

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Governance
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
              Compliance guardrails
            </h2>
            <p className="mt-2 text-sm text-[var(--bo-muted)]">
              Adjust the policies that protect your docs and fragment lifecycle.
            </p>
          </div>
          <button
            type="button"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Edit policies
          </button>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2">
          {[
            "Require peer review for all fragment releases",
            "Lock docs publish while adapters are pending",
            "Auto-snapshot API schema diffs",
            "Notify partner teams 48 hours before releases",
          ].map((rule) => (
            <div
              key={rule}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-muted)]"
            >
              {rule}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
