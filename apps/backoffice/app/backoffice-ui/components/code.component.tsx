import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Code: ComponentFn<typeof backofficeUiCatalog, "Code"> = ({ props }) => (
  <figure className="min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
    {props.label || props.language ? (
      <figcaption className="flex items-center justify-between gap-3 border-b border-[color:var(--bo-border)] px-3 py-2 text-[9px] font-semibold tracking-[0.18em] text-[var(--bo-muted-2)] uppercase">
        <span>{props.label ?? "Code"}</span>
        {props.language ? <span>{props.language}</span> : null}
      </figcaption>
    ) : null}
    <pre
      aria-label={props.label ?? "Code"}
      className="backoffice-scroll max-h-96 overflow-auto p-3 font-mono text-[11px] leading-5 whitespace-pre text-[var(--bo-fg)]"
    >
      <code>{props.code}</code>
    </pre>
  </figure>
);
