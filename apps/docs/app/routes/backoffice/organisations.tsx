import { BackofficePageHeader } from "@/components/backoffice";

const ORGS = [
  {
    name: "Fragno Labs",
    plan: "Studio",
    members: "18 members",
    activity: "Release train active",
  },
  {
    name: "DocWorks",
    plan: "Workspace",
    members: "7 members",
    activity: "Docs refresh sprint",
  },
  {
    name: "Orbit Partners",
    plan: "Sandbox",
    members: "4 members",
    activity: "Integration prototyping",
  },
  {
    name: "Cobalt Guild",
    plan: "Enterprise",
    members: "29 members",
    activity: "Compliance review",
  },
];

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
        {ORGS.map((org) => (
          <div
            key={org.name}
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
