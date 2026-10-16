import { Field } from "@fragno-private/design-system/field";
import { Select as SelectControl } from "@fragno-private/design-system/select";
import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const Select: ComponentFn<typeof backofficeUiCatalog, "Select"> = ({ props, bindings }) => {
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
      <SelectControl
        controlId={id}
        density="compact"
        options={props.options}
        value={value ?? null}
        placeholder="Choose an option"
        required={props.required === true}
        disabled={props.disabled === true || !host || !host.canEditInput()}
        onValueChange={(nextValue) => {
          setValue(nextValue ?? "");
        }}
      />
    </Field>
  );
};
