import { Link } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import { toCfSandboxPath } from "./cf-sandbox-path";

const ENVIRONMENTS = [
  {
    id: "workers",
    name: "Workers",
    description:
      "Queue and inspect Cloudflare Workers deployments against the shared dispatch namespace.",
    status: "Available",
    to: "/backoffice/environments/workers",
  },
  {
    id: "cf-sandbox",
    name: "CF Sandbox",
    description:
      "Validate fragment behavior against the Cloudflare sandbox runtime before promoting changes.",
    status: "Available",
  },
];

export function meta() {
  return [
    { title: "Backoffice Environments" },
    { name: "description", content: "Manage runtime environments used by the backoffice." },
  ];
}

export default function BackofficeEnvironments() {
  const cfSandboxPath = toCfSandboxPath({});

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Environments" }]}
        eyebrow="Runtime"
        title="Environment catalog and provisioning status."
        description="Review and manage the isolated environments used to validate fragment operations."
      />

      <section className="grid gap-3 md:grid-cols-2">
        {ENVIRONMENTS.map((environment) => (
          <div
            key={environment.id}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  {environment.status}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  {environment.name}
                </h2>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                Live
              </span>
            </div>
            <p className="mt-4 text-sm text-[var(--bo-muted)]">{environment.description}</p>
            <div className="mt-4">
              <Link
                to={cfSandboxPath}
                className="inline-flex border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-accent-fg)] transition-colors hover:border-[color:var(--bo-accent-strong)]"
              >
                Open
              </Link>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
