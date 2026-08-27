import { Link, useOutletContext } from "react-router";

import { BackofficePageHeader, BackofficeStatusLight } from "@/components/backoffice";

import { internalsScopeBasePath } from "./internals-scope";
import type { InternalsLayoutContext } from "./layout";

type InternalDestination = {
  id: string;
  name: string;
  description: string;
  status: "Available" | "Planned";
  to: string | null;
};

function internalDestinations(
  hasOrganization: boolean,
  internalsBasePath: string,
): InternalDestination[] {
  return [
    {
      id: "users",
      name: "Users",
      description: "Review every system account and manage global administrator access.",
      status: "Available",
      to: `${internalsBasePath}/users`,
    },
    {
      id: "github",
      name: "GitHub",
      description:
        "Inspect GitHub App runtime configuration and singleton installation routing state.",
      status: "Available",
      to: `${internalsBasePath}/github`,
    },
    {
      id: "cloudflare-browser-run",
      name: "Cloudflare Browser Run",
      description: "Create Browser Run sessions and exercise their target lifecycle APIs.",
      status: "Available",
      to: `${internalsBasePath}/cloudflare/browser-run`,
    },
    {
      id: "generated-ui",
      name: "Generated UI",
      description:
        "Preview every component and semantic variant in the production codemode presentation catalog.",
      status: "Available",
      to: `${internalsBasePath}/generated-ui`,
    },
    {
      id: "upload",
      name: "Upload",
      description: "Configure upload storage and inspect organization-scoped upload operations.",
      status: hasOrganization ? "Available" : "Planned",
      to: hasOrganization ? "/backoffice/connections/upload" : null,
    },
    {
      id: "durable-hooks",
      name: "Durable hooks",
      description:
        "Inspect durable hook queues and retry state across organization and singleton scopes.",
      status: "Available",
      to: `${internalsBasePath}/durable-hooks`,
    },
    {
      id: "workflows",
      name: "Workflows",
      description:
        "Inspect workflow instances, state transitions, and step/event history by fragment.",
      status: "Available",
      to: `${internalsBasePath}/workflows`,
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
  const { me, selectedRouteScope } = useOutletContext<InternalsLayoutContext>();
  const hasOrganization = me.organizations.length > 0;
  const internalsBasePath = internalsScopeBasePath(selectedRouteScope);
  const destinations = internalDestinations(hasOrganization, internalsBasePath);

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Internals" }]}
        eyebrow="Administration"
        title="Durable systems and operational tooling."
        description="Inspect the internal queues, hooks, service adapters, and control planes that power fragments."
      />

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {destinations.map((item) => {
          const isAvailable = Boolean(item.to);
          return (
            <div
              key={item.id}
              className="bo-fragment-surface bo-panel-surface flex min-h-52 flex-col bg-[var(--bo-panel)] p-4"
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
                <BackofficeStatusLight tone={isAvailable ? "live" : "waiting"}>
                  {isAvailable ? "Online" : "Planned"}
                </BackofficeStatusLight>
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
