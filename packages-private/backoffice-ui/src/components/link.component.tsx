import { Link as RouterLink } from "react-router";

import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiRenderContext } from "../render-context";

export const Link: ComponentFn<typeof backofficeUiCatalog, "Link"> = ({ props }) => {
  const { links } = useBackofficeUiRenderContext();
  if (links === null) {
    return <span className="text-xs font-semibold text-[var(--bo-fg)]">{props.label}</span>;
  }
  return (
    <RouterLink
      to={links(props.to)}
      className="block truncate text-xs font-semibold text-[var(--bo-accent-fg)] hover:underline"
      title={props.label}
    >
      {props.label}
    </RouterLink>
  );
};
