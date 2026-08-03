import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiInteractionHost } from "../interaction";

export const Select: ComponentFn<typeof backofficeUiCatalog, "Select"> = ({ props, bindings }) => {
  const id = useId();
  const host = useBackofficeUiInteractionHost();
  const [value, setValue] = useBoundProp(props.value, bindings?.value);

  return (
    <label htmlFor={id} className="block min-w-0">
      <span className="block text-[10px] font-semibold tracking-[0.08em] text-[var(--bo-fg)]">
        {props.label}
        {props.required ? <span className="ml-1 text-[var(--bo-failed)]">*</span> : null}
      </span>
      {props.description ? (
        <span className="mt-1 block text-[10px] leading-4 text-[var(--bo-muted-2)]">
          {props.description}
        </span>
      ) : null}
      <select
        id={id}
        value={value ?? ""}
        required={props.required}
        disabled={props.disabled || host?.canEditWorkflowInput?.() === false}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="mt-2 min-h-10 w-full border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 text-xs text-[var(--bo-fg)] transition-[border-color,box-shadow] duration-150 outline-none focus:border-[color:var(--bo-accent)] focus:shadow-[0_0_0_3px_var(--bo-accent-bg)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
};
