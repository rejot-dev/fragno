import type { ControlProps, RankedTester } from "@jsonforms/core";
import { isRangeControl, rankWith } from "@jsonforms/core";
import { withJsonFormsControlProps } from "@jsonforms/react";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldContent,
} from "@/components/ui/field";
import { ShadcnSlider } from "../shadcn-controls/ShadcnSlider";

export const ShadcnSliderControl = ({
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

  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? 100;
  const defaultValue = schema.default ?? min;
  const currentValue = data ?? defaultValue;

  return (
    <Field data-invalid={!isValid || undefined} data-disabled={!enabled || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={`${id}-input`}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>

      <div className="flex items-center justify-between">
        <span> </span>
        <span className="text-muted-foreground text-sm tabular-nums">{currentValue}</span>
      </div>
      <ShadcnSlider
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
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{min}</span>
        <span>{max}</span>
      </div>

      {!isValid && <FieldError errors={[{ message: errors }]} />}
    </Field>
  );
};

export const shadcnSliderControlTester: RankedTester = rankWith(5, isRangeControl);

export const ShadcnSliderControlContext = withJsonFormsControlProps(ShadcnSliderControl);
