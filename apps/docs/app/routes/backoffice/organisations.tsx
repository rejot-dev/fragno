import { Link } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import { ORGANISATIONS } from "./organisations.data";

export function meta() {
  return [
    { title: "Backoffice Organisations" },
    { name: "description", content: "Manage organisations for the Fragno backoffice." },
  ];
}

export default function BackofficeOrganisations() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Organisations" }]}
        eyebrow="Directory"
        title="Organisation rosters and access levels."
        description="Track the teams that own fragment libraries, docs chapters, and release cycles."
      />

      <section className="grid gap-3 md:grid-cols-2">
        {ORGANISATIONS.map((org) => (
          <div
            key={org.id}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  {org.plan}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{org.name}</h2>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                Active
              </span>
            </div>
            <div className="mt-4 space-y-2 text-sm text-[var(--bo-muted)]">
              <p className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                  Members
                </span>
                <span className="font-semibold text-[var(--bo-fg)]">{org.members}</span>
              </p>
              <p className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                  Focus
                </span>
                <span>{org.activity}</span>
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to={`/backoffice/organisations/${org.id}/telegram`}
                className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
              >
                Telegram
              </Link>
              {["Members", "Permissions", "Roadmap"].map((label) => (
                <button
                  key={label}
                  type="button"
                  className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
