import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router";

import { useBackofficeUiRenderContext } from "../render-context";
import type { BackofficeUiLinkTarget } from "./link";

/** Leads to a target in the current scope; outside a scope it shows its content unlinked. */
export function ScopeLink({
  to,
  label,
  className,
  children,
}: {
  to: BackofficeUiLinkTarget;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const { links } = useBackofficeUiRenderContext();
  if (links === null) {
    return <span className={className}>{children}</span>;
  }
  return (
    <RouterLink to={links(to)} className={className} title={label}>
      {children}
    </RouterLink>
  );
}
