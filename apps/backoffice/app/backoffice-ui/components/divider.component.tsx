import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";

export const Divider: ComponentFn<typeof backofficeUiCatalog, "Divider"> = ({ props }) =>
  props.label ? (
    <div className="flex items-center gap-3">
      <hr aria-label={props.label} className="flex-1 border-0 border-t border-[var(--bo-border)]" />
      <span className="text-[9px] font-semibold tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">
        {props.label}
      </span>
      <span className="h-px flex-1 bg-[var(--bo-border)]" aria-hidden="true" />
    </div>
  ) : (
    <hr className="border-0 border-t border-[var(--bo-border)]" />
  );
