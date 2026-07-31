import type { ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { backofficeUiVariantClasses } from "./variants";

const progressBarClass = {
  neutral: "bg-[var(--bo-muted-2)]",
  accent: "bg-[var(--bo-accent)]",
  live: "bg-[var(--bo-live)]",
  warning: "bg-[var(--bo-waiting)]",
  failed: "bg-[var(--bo-failed)]",
} as const;

export const Progress: ComponentFn<typeof backofficeUiCatalog, "Progress"> = ({ props }) => {
  const value = Math.min(100, Math.max(0, props.value));

  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value}%${props.detail ? ` · ${props.detail}` : ""}`}
      className={`border p-3 ${backofficeUiVariantClasses[props.variant]}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[9px] font-semibold tracking-[0.18em] uppercase">{props.label}</p>
        <p className="font-mono text-xs font-semibold tabular-nums">{value}%</p>
      </div>
      <div className="mt-2 h-1.5 bg-[var(--bo-panel)]" aria-hidden="true">
        <div
          className={`h-full ${progressBarClass[props.variant]}`}
          style={{ width: `${value}%` }}
        />
      </div>
      {props.detail ? <p className="mt-2 text-[10px] text-[var(--bo-fg)]">{props.detail}</p> : null}
    </div>
  );
};
