import type { ControlProps, OwnPropsOfEnum, RankedTester } from "@jsonforms/core";
import { isOneOfEnumControl, rankWith } from "@jsonforms/core";
import { withJsonFormsOneOfEnumProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnSelect } from "../shadcn-controls/ShadcnSelect";

export const ShadcnOneOfEnumControl = ({
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
  options,
}: ControlProps & OwnPropsOfEnum) => {
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  return (
    <Field data-invalid={!isValid || undefined} data-disabled={!enabled || undefined}>
      <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnSelect
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
        options={options ?? []}
      />
      {!isValid && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnOneOfEnumControlTester: RankedTester = rankWith(5, isOneOfEnumControl);

export const ShadcnOneOfEnumControlContext = withJsonFormsOneOfEnumProps(ShadcnOneOfEnumControl);
