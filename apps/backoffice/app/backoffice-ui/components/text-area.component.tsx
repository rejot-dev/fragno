import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const TextArea: ComponentFn<typeof backofficeUiCatalog, "TextArea"> = ({
  props,
  bindings,
}) => {
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
      <textarea
        id={id}
        value={value ?? ""}
        placeholder={props.placeholder}
        required={props.required}
        disabled={props.disabled || !host || !host.canEditInput()}
        rows={props.rows ?? 4}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="bo-input mt-2 w-full resize-y px-3 py-2.5 text-xs leading-5"
      />
    </label>
  );
};
