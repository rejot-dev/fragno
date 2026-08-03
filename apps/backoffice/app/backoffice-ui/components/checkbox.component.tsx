import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiInteractionHost } from "../interaction";

export const Checkbox: ComponentFn<typeof backofficeUiCatalog, "Checkbox"> = ({
  props,
  bindings,
}) => {
  const id = useId();
  const host = useBackofficeUiInteractionHost();
  const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);

  return (
    <label
      htmlFor={id}
      className="flex min-h-10 cursor-pointer items-start gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2.5 has-disabled:cursor-not-allowed has-disabled:opacity-50"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked ?? false}
        required={props.required}
        disabled={props.disabled || host?.canEditWorkflowInput?.() === false}
        onChange={(event) => {
          setChecked(event.target.checked);
        }}
        className="mt-0.5 size-4 shrink-0 accent-[var(--bo-accent)]"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-[var(--bo-fg)]">
          {props.label}
          {props.required ? <span className="ml-1 text-[var(--bo-failed)]">*</span> : null}
        </span>
        {props.description ? (
          <span className="mt-1 block text-[10px] leading-4 text-[var(--bo-muted-2)]">
            {props.description}
          </span>
        ) : null}
      </span>
    </label>
  );
};
