import { Field } from "@fragno-private/design-system/field";
import { TextArea as TextAreaControl } from "@fragno-private/design-system/text-area";
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
    <Field
      controlId={id}
      density="compact"
      label={props.label}
      description={props.description}
      required={props.required === true}
      error={null}
    >
      <TextAreaControl
        id={id}
        density="compact"
        value={value ?? ""}
        placeholder={props.placeholder}
        required={props.required}
        disabled={props.disabled || !host || !host.canEditInput()}
        rows={props.rows ?? 4}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
    </Field>
  );
};
