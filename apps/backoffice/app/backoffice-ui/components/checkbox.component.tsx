import { CheckboxField } from "@fragno-private/design-system/field";
import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const Checkbox: ComponentFn<typeof backofficeUiCatalog, "Checkbox"> = ({
  props,
  bindings,
}) => {
  const id = useId();
  const host = useWorkflowUiInteractionHost();
  const [checked, setChecked] = useBoundProp(props.checked, bindings?.checked);

  return (
    <CheckboxField
      controlId={id}
      density="compact"
      label={props.label}
      description={props.description}
      required={props.required === true}
      disabled={props.disabled === true || !host || !host.canEditInput()}
      checked={checked ?? false}
      error={null}
      onCheckedChange={setChecked}
    />
  );
};
