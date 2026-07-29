import { Link, useOutletContext } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import { authClient } from "@/fragno/auth/auth-client";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

type InternalDestination = {
  id: string;
  name: string;
  description: string;
  status: "Available" | "Planned";
  to: string | null;
};

function internalDestinations(hasOrganization: boolean): InternalDestination[] {
  return [
    {
      id: "github",
      name: "GitHub",
      description:
        "Inspect GitHub App runtime configuration and singleton installation routing state.",
      status: "Available",
      to: "/backoffice/internals/github",
    },
    {
      id: "upload",
      name: "Upload",
      description: "Configure upload storage and inspect organisation-scoped upload operations.",
      status: hasOrganization ? "Available" : "Planned",
      to: hasOrganization ? "/backoffice/connections/upload" : null,
    },
    {
      id: "reson8",
      name: "Reson8",
      description: "Inspect transcription configuration, models, and runtime operations.",
      status: hasOrganization ? "Available" : "Planned",
      to: hasOrganization ? "/backoffice/connections/reson8" : null,
    },
    {
      id: "durable-hooks",
      name: "Durable hooks",
      description:
        "Inspect durable hook queues and retry state across organisation and singleton scopes.",
      status: "Available",
      to: "/backoffice/internals/durable-hooks",
    },
    {
      id: "workflows",
      name: "Workflows",
      description:
        "Inspect workflow instances, state transitions, and step/event history by fragment.",
      status: "Available",
      to: "/backoffice/internals/workflows",
    },
    {
      id: "audit-log",
      name: "Audit log",
      description: "Review administrative events and operational metadata for each workspace.",
      status: "Planned",
      to: null,
    },
  ];
}

export function meta() {
  return [
    { title: "Backoffice Internals" },
    { name: "description", content: "Monitor internal backoffice services and queues." },
  ];
}

export default function BackofficeInternals() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const { data: currentMe } = authClient.useMe();
  const destinations = internalDestinations((currentMe ?? me).organizations.length > 0);

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Internals" }]}
        eyebrow="Administration"
        title="Durable systems and operational tooling."
        description="Inspect the internal queues, hooks, connections, and control planes that power fragments."
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {destinations.map((item) => {
          const isAvailable = Boolean(item.to);
          return (
            <div
              key={item.id}
              className="bo-panel-surface flex min-h-52 flex-col bg-[var(--bo-panel)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                    {item.status}
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-balance text-[var(--bo-fg)]">
                    {item.name}
                  </h2>
                </div>
                <span className="shrink-0 bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase shadow-[inset_0_0_0_1px_var(--bo-border)]">
                  {isAvailable ? "Live" : "Soon"}
                </span>
              </div>
              <p className="mt-4 text-sm text-pretty text-[var(--bo-muted)]">{item.description}</p>
              <div className="mt-auto pt-4">
                {isAvailable ? (
                  <Link
                    to={item.to!}
                    className="inline-flex min-h-10 items-center bg-[var(--bo-accent-bg)] px-3 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase shadow-[inset_0_0_0_1px_var(--bo-accent)] transition-[scale,box-shadow] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_var(--bo-accent-strong)] active:scale-[0.96]"
                  >
                    Open
                  </Link>
                ) : (
                  <span className="inline-flex min-h-10 items-center bg-[var(--bo-panel-2)] px-3 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase shadow-[inset_0_0_0_1px_var(--bo-border)]">
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
