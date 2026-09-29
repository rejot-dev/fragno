import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const Select: ComponentFn<typeof backofficeUiCatalog, "Select"> = ({ props, bindings }) => {
  const id = useId();
  const host = useWorkflowUiInteractionHost();
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
        disabled={props.disabled || !host || !host.canEditInput()}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="bo-input mt-2 min-h-10 w-full px-3 text-xs"
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
