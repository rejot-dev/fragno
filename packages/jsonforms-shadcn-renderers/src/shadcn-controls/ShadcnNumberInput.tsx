import type { CellProps, WithClassname } from "@jsonforms/core";
import { memo } from "react";
import { Input } from "@/components/ui/input";

type ShadcnNumberInputProps = CellProps &
  WithClassname & {
    step?: string;
  };

export const ShadcnNumberInput = memo(function ShadcnNumberInput(props: ShadcnNumberInputProps) {
  const { data, className, id, enabled, path, handleChange, schema, step } = props;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      handleChange(path, undefined);
    } else {
      const parsed = Number(value);
      handleChange(path, isNaN(parsed) ? undefined : parsed);
    }
  };

  return (
    <Input
      type="number"
      value={data ?? ""}
      onChange={handleInputChange}
      className={className}
      id={id}
      disabled={!enabled}
      min={schema.minimum}
      max={schema.maximum}
      step={step ?? (schema.multipleOf ? String(schema.multipleOf) : undefined)}
    />
  );
});
