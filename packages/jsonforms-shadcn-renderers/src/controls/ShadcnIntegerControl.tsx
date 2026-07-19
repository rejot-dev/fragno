import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isIntegerControl, rankWith } from "@jsonforms/core";

import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";

import { useTouched } from "../hooks/useTouched";
import { withJsonFormsControlProps } from "../jsonforms-hocs";
import { ShadcnNumberInput } from "../shadcn-controls/ShadcnNumberInput";

export const ShadcnIntegerControl = (props: ControlProps) => {
  const {
    data,
    visible,
    label,
    id,
    enabled,
    uischema,
    schema,
    rootSchema,
    errors,
    path,
    config,
    description,
    required,
  } = props;
  const { showErrors, markTouched } = useTouched(data);
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  const handleChangeWithTouch = (path: string, value: number | undefined) => {
    markTouched();
    props.handleChange(path, value);
  };

  return (
    <Field
      data-invalid={(!isValid && showErrors) || undefined}
      data-disabled={!enabled || undefined}
    >
      <FieldLabel htmlFor={`${id}-input`}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </FieldLabel>
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
        handleChange={handleChangeWithTouch}
        errors={errors}
        config={config}
        isValid={isValid}
        step="1"
      />
      {!isValid && showErrors && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnIntegerControlTester: RankedTester = rankWith(4, isIntegerControl);

export const ShadcnIntegerControlContext = withJsonFormsControlProps(ShadcnIntegerControl);
