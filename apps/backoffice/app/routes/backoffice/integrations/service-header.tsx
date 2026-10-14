import { BackofficeBreadcrumbs } from "@fragno-private/design-system/breadcrumbs";
import type { ReactNode } from "react";

/** Header for a native service's own pages, which sit under the Integrations section. */
export function IntegrationServiceHeader({
  integrationsPath,
  service,
  scopeLabel,
  subnav,
}: {
  integrationsPath: string;
  service: string;
  scopeLabel: string;
  subnav: ReactNode;
}) {
  return (
    <section className="bo-fragment-surface overflow-hidden bg-[var(--bo-panel)] pb-2">
      <div className="px-4 pt-4">
        <BackofficeBreadcrumbs
          items={[{ label: "Integrations", to: integrationsPath }, { label: service }]}
        />
        <h1 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
          {service}
          <span className="font-normal text-[var(--bo-muted)]"> · {scopeLabel}</span>
        </h1>
      </div>
      <div className="px-3 py-2 md:px-4">{subnav}</div>
    </section>
  );
}
