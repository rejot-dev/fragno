import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isStringControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnInput } from "../shadcn-controls/ShadcnInput";
import { useTouched } from "../hooks/useTouched";

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
  required,
}: ControlProps) => {
  const { showErrors, markTouched } = useTouched(data);
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  const placeholder = uischema.options?.["placeholder"] as string | undefined;

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
      <ShadcnInput
        id={`${id}-input`}
        data={data}
        enabled={enabled}
        path={path}
        schema={schema}
        handleChange={handleChangeWithTouch}
        placeholder={placeholder}
      />
      {!isValid && showErrors && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnTextControlTester: RankedTester = rankWith(1, isStringControl);

export const ShadcnTextControlContext = withJsonFormsControlProps(ShadcnTextControl);
