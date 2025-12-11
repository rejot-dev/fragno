import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Slider } from "@/components/ui/slider";

type ShadcnSliderProps = CellProps & WithClassname;

export const ShadcnSlider = memo(function ShadcnSlider(props: ShadcnSliderProps) {
  const { data, className, id, enabled, path, handleChange, schema } = props;

  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? 100;
  const step = schema.multipleOf ?? 1;
  const defaultValue = schema.default ?? min;

  const handleSliderChange = (value: number[]) => {
    handleChange(path, value[0]);
  };

  return (
    <Slider
      value={[data ?? defaultValue]}
      onValueChange={handleSliderChange}
      className={className}
      id={id}
      disabled={!enabled}
      min={min}
      max={max}
      step={step}
    />
  );
});
