import type { ControlProps, RankedTester } from "@jsonforms/core";
import { and, isStringControl, optionIs, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";
import { ShadcnTextarea } from "../shadcn-controls/ShadcnTextarea";
import { useTouched } from "../hooks/useTouched";

export const ShadcnTextAreaControl = ({
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
      <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <ShadcnTextarea
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
        placeholder={placeholder}
      />
      {!isValid && showErrors && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnTextAreaControlTester: RankedTester = rankWith(
  2,
  and(isStringControl, optionIs("multi", true)),
);

export const ShadcnTextAreaControlContext = withJsonFormsControlProps(ShadcnTextAreaControl);
