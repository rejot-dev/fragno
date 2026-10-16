import { ButtonLink } from "@fragno-private/design-system/button";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

import { DetailSection } from "./connection-display";
import { integrationBasePath } from "./connection-paths";

/** Native services keep their configuration and history on their own pages. */
export function NativeConnectionDetails({
  selectedScope,
  service,
}: {
  selectedScope: BackofficeScopeSelection;
  service: string;
}) {
  return (
    <DetailSection title="Native service">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <p className="text-xs text-[var(--bo-muted)]">
          Configured and managed on the service&apos;s own page.
        </p>
        <ButtonLink variant="secondary" to={integrationBasePath(selectedScope, service)}>
          Open
        </ButtonLink>
      </div>
    </DetailSection>
  );
}
