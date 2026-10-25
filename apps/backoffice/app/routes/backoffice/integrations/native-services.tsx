import { ButtonLink } from "@fragno-private/design-system/button";
import { SurfacePanel } from "@fragno-private/design-system/surface-panel";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { backofficeConnectionCatalog } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import { integrationBasePath } from "./connection-paths";

/** Native services whose management pages serve the system scope. */
const SYSTEM_SERVICE_IDS: readonly string[] = ["telegram", "resend"];

const SYSTEM_FORMS = {
  label: "Forms",
  description: "Create schema-backed forms and inspect their submissions.",
  routeSegment: "forms",
};

/**
 * Lists the system scope's native services. A service only reports a connection once it is
 * configured, so the table alone cannot lead to an unconfigured one.
 */
export function NativeServices({ selectedScope }: { selectedScope: BackofficeScopeSelection }) {
  if (selectedScope.kind !== "system") {
    return null;
  }
  const services = [
    ...backofficeConnectionCatalog.flatMap((service) =>
      service.routeSegment !== undefined && SYSTEM_SERVICE_IDS.includes(service.id)
        ? [{ ...service, routeSegment: service.routeSegment }]
        : [],
    ),
    SYSTEM_FORMS,
  ];

  return (
    <SurfacePanel caption="Built-in services" actions={null}>
      <ul className="divide-y divide-[color:var(--bo-border)] border-t border-[color:var(--bo-border)]">
        {services.map((service) => (
          <li
            key={service.routeSegment}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--bo-fg)]">{service.label}</p>
              <p className="text-xs text-[var(--bo-muted)]">{service.description}</p>
            </div>
            <ButtonLink
              variant="secondary"
              to={integrationBasePath(selectedScope, service.routeSegment)}
            >
              Manage
            </ButtonLink>
          </li>
        ))}
      </ul>
    </SurfacePanel>
  );
}
