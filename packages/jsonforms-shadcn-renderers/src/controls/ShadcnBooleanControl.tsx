import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isBooleanControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldContent,
} from "@/components/ui/field";
import { ShadcnCheckbox } from "../shadcn-controls/ShadcnCheckbox";

export const ShadcnBooleanControl = ({
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
    <Field
      orientation="horizontal"
      data-invalid={!isValid || undefined}
      data-disabled={!enabled || undefined}
    >
      <ShadcnCheckbox
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
      />
      <FieldContent>
        <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
        {!isValid && <FieldError errors={[{ message: errors }]} />}
      </FieldContent>
    </Field>
  );
};

export const shadcnBooleanControlTester: RankedTester = rankWith(2, isBooleanControl);

export const ShadcnBooleanControlContext = withJsonFormsControlProps(ShadcnBooleanControl);
