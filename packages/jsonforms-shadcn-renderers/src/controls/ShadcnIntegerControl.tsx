import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isIntegerControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnNumberInput } from "../shadcn-controls/ShadcnNumberInput";

export const ShadcnIntegerControl = ({
  data,
  visible,
  label,
  id,
  enabled,
  uischema,
  schema,
  rootSchema,
  handleChange,
  errors,
  path,
  config,
  description,
}: ControlProps) => {
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  return (
    <Field data-invalid={!isValid || undefined} data-disabled={!enabled || undefined}>
      <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnNumberInput
        id={`${id}-input`}
        data={data}
        enabled={enabled}
        visible={visible}
        path={path}
        uischema={uischema}
        schema={schema}
        rootSchema={rootSchema}
        handleChange={handleChange}
        errors={errors}
        config={config}
        isValid={isValid}
        step="1"
      />
      {!isValid && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnIntegerControlTester: RankedTester = rankWith(4, isIntegerControl);

export const ShadcnIntegerControlContext = withJsonFormsControlProps(ShadcnIntegerControl);
