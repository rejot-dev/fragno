import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isTimeControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnTimePicker } from "../shadcn-controls/ShadcnTimePicker";
import { useTouched } from "../hooks/useTouched";

export const ShadcnTimeControl = ({
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
  required,
}: ControlProps) => {
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
      <FieldLabel htmlFor={`${id}-input`}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnTimePicker
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
      />
      {!isValid && showErrors && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnTimeControlTester: RankedTester = rankWith(4, isTimeControl);

export const ShadcnTimeControlContext = withJsonFormsControlProps(ShadcnTimeControl);
