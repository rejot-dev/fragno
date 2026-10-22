import { Field } from "@fragno-private/design-system/field";
import { Select as SelectControl } from "@fragno-private/design-system/select";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const Select: ComponentFn<typeof backofficeUiCatalog, "Select"> = ({ props, bindings }) => {
  const host = useWorkflowUiInteractionHost();
  const [value, setValue] = useBoundProp(props.value, bindings?.value);

  return (
    <Field
      density="compact"
      label={props.label}
      description={props.description}
      required={props.required === true}
    >
      <SelectControl
        density="compact"
        options={props.options}
        value={value ?? null}
        required={props.required === true}
        disabled={props.disabled === true || !host || !host.canEditInput()}
        onValueChange={(nextValue) => {
          setValue(nextValue ?? "");
        }}
      />
    </Field>
  );
};
