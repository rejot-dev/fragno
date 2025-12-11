import type { ControlProps, RankedTester } from "@jsonforms/core";
import { and, isBooleanControl, optionIs, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldContent,
} from "@/components/ui/field";
import { ShadcnSwitch } from "../shadcn-controls/ShadcnSwitch";

export const ShadcnBooleanToggleControl = ({
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
      <ShadcnSwitch
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

export const shadcnBooleanToggleControlTester: RankedTester = rankWith(
  3,
  and(isBooleanControl, optionIs("toggle", true)),
);

export const ShadcnBooleanToggleControlContext = withJsonFormsControlProps(
  ShadcnBooleanToggleControl,
);
