import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Text: ComponentFn<typeof backofficeUiCatalog, "Text"> = ({ props }) => (
  <p
    className={`text-xs leading-5 ${props.tone === "default" ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted)]"}`}
  >
    {props.text}
  </p>
);
