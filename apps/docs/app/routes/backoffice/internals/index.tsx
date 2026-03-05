import { Link } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";

const INTERNALS = [
  {
    id: "durable-hooks",
    name: "Durable hooks",
    description:
      "Inspect durable hook queues and retry state across organisation and singleton scopes.",
    status: "Available",
    to: "/backoffice/internals/durable-hooks",
  },
  {
    id: "audit-log",
    name: "Audit log",
    description: "Review administrative events and operational metadata for each workspace.",
    status: "Planned",
    to: null,
  },
];

export function meta() {
  return [
    { title: "Backoffice Internals" },
    { name: "description", content: "Monitor internal backoffice services and queues." },
  ];
}

export default function BackofficeInternals() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Internals" }]}
        eyebrow="Internals"
        title="Durable systems and operational tooling."
        description="Keep an eye on the internal queues, hooks, and control planes that power fragments."
      />

      <section className="grid gap-3 md:grid-cols-2">
        {INTERNALS.map((item) => {
          const isAvailable = Boolean(item.to);
          return (
            <div
              key={item.id}
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                    {item.status}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">{item.name}</h2>
                </div>
                <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                  {isAvailable ? "Live" : "Soon"}
                </span>
              </div>
              <p className="mt-4 text-sm text-[var(--bo-muted)]">{item.description}</p>
              <div className="mt-4">
                {isAvailable ? (
                  <Link
                    to={item.to!}
                    className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
                  >
                    Open
                  </Link>
                ) : (
                  <span className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                    Coming soon
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
