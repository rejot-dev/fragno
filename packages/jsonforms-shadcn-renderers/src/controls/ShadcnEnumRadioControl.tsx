import type { ControlProps, OwnPropsOfEnum, RankedTester } from "@jsonforms/core";
import { and, isEnumControl, optionIs, rankWith } from "@jsonforms/core";
import { withJsonFormsEnumProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnRadioGroup } from "../shadcn-controls/ShadcnRadioGroup";
import { useTouched } from "../hooks/useTouched";

export const ShadcnEnumRadioControl = ({
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
  const { showErrors, markTouched } = useTouched(data);
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  const handleChangeWithTouch = (path: string, value: string | undefined) => {
    markTouched();
    handleChange(path, value);
  };

  return (
    <Field
      data-invalid={(!isValid && showErrors) || undefined}
      data-disabled={!enabled || undefined}
    >
      <FieldLabel>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnRadioGroup
        id={`${id}-input`}
        data={data}
        enabled={enabled}
        visible={visible}
        path={path}
        uischema={uischema}
        schema={schema}
        rootSchema={rootSchema}
        handleChange={handleChangeWithTouch}
        errors={errors}
        config={config}
        isValid={isValid}
        options={options ?? []}
      />
      {!isValid && showErrors && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnEnumRadioControlTester: RankedTester = rankWith(
  20,
  and(isEnumControl, optionIs("format", "radio")),
);

export const ShadcnEnumRadioControlContext = withJsonFormsEnumProps(ShadcnEnumRadioControl);
