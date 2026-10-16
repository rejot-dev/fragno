import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { useId } from "react";

import { useBoundProp, type ComponentFn } from "@json-render/react";

import type { backofficeUiCatalog } from "../catalog";
import { useWorkflowUiInteractionHost } from "../workflow-interaction";

export const TextInput: ComponentFn<typeof backofficeUiCatalog, "TextInput"> = ({
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
      <Input
        id={id}
        density="compact"
        type={props.secret ? "password" : "text"}
        value={value ?? ""}
        placeholder={props.placeholder}
        autoComplete={props.secret ? "off" : undefined}
        required={props.required}
        disabled={props.disabled || !host || !host.canEditInput()}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="w-full"
      />
    </Field>
  );
};
