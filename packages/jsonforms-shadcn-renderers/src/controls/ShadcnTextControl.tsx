import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isStringControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnInput } from "../shadcn-controls/ShadcnInput";

export const ShadcnTextControl = ({
  data,
  visible,
  label,
  id,
  enabled,
  schema,
  handleChange,
  errors,
  path,
  description,
  uischema,
}: ControlProps) => {
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  const placeholder = uischema.options?.["placeholder"] as string | undefined;

  return (
    <Field data-invalid={!isValid || undefined} data-disabled={!enabled || undefined}>
      <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnInput
        id={`${id}-input`}
        data={data}
        enabled={enabled}
        path={path}
        schema={schema}
        handleChange={handleChange}
        placeholder={placeholder}
      />
      {!isValid && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnTextControlTester: RankedTester = rankWith(1, isStringControl);

export const ShadcnTextControlContext = withJsonFormsControlProps(ShadcnTextControl);
