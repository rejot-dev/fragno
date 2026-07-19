import type { ControlProps, OwnPropsOfEnum, RankedTester } from "@jsonforms/core";
import { isOneOfEnumControl, rankWith } from "@jsonforms/core";

import { Field, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field";

import { useTouched } from "../hooks/useTouched";
import { withJsonFormsOneOfEnumProps } from "../jsonforms-hocs";
import { ShadcnSelect } from "../shadcn-controls/ShadcnSelect";

export const ShadcnOneOfEnumControl = (props: ControlProps & OwnPropsOfEnum) => {
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
    options,
    required,
  } = props;
  const { showErrors, markTouched } = useTouched(data);
  const isValid = errors.length === 0;

  if (!visible) {
    return null;
  }

  const handleChangeWithTouch = (path: string, value: string | undefined) => {
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
      <ShadcnSelect
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

export const shadcnOneOfEnumControlTester: RankedTester = rankWith(5, isOneOfEnumControl);

export const ShadcnOneOfEnumControlContext = withJsonFormsOneOfEnumProps(ShadcnOneOfEnumControl);
