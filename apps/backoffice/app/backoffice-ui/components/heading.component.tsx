import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

const headingClassName = {
  2: "text-lg leading-tight",
  3: "text-sm leading-tight",
  4: "text-xs leading-tight",
} as const;

export const Heading: ComponentFn<typeof backofficeUiCatalog, "Heading"> = ({ props }) => {
  const level = props.level ?? 3;
  const className = `${headingClassName[level]} font-semibold text-[var(--bo-fg)]`;

  if (level === 2) {
    return <h2 className={className}>{props.text}</h2>;
  }
  if (level === 4) {
    return <h4 className={className}>{props.text}</h4>;
  }
  return <h3 className={className}>{props.text}</h3>;
};
