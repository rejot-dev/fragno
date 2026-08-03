import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useBackofficeUiInteractionHost } from "../interaction";

export const TextArea: ComponentFn<typeof backofficeUiCatalog, "TextArea"> = ({
  props,
  bindings,
}) => {
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
      <textarea
        id={id}
        value={value ?? ""}
        placeholder={props.placeholder}
        required={props.required}
        disabled={props.disabled || host?.canEditWorkflowInput?.() === false}
        rows={props.rows ?? 4}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="mt-2 w-full resize-y border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] px-3 py-2.5 text-xs leading-5 text-[var(--bo-fg)] transition-[border-color,box-shadow] duration-150 outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:shadow-[0_0_0_3px_var(--bo-accent-bg)] disabled:cursor-not-allowed disabled:opacity-50"
      />
    </label>
  );
};
