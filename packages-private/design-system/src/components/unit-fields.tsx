import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import { FormField } from "./form-container";
import { Input } from "./input";
import {
  BYTE_UNITS,
  formatUnitNumber,
  pickReadableDisplayUnit,
  resolveUnit,
  type UnitOption,
} from "./units";

type ResolveDisplayUnitInput<UnitId extends string> = {
  outputValue: number;
  outputUnit: UnitOption<UnitId>;
  units: readonly UnitOption<UnitId>[];
};

type UnitNumberFieldProps<UnitId extends string> = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  units: readonly UnitOption<UnitId>[];
  outputUnit: UnitId;
  defaultDisplayUnit?: UnitId;
  resolveDisplayUnit?: (input: ResolveDisplayUnitInput<UnitId>) => UnitId;
  step?: number | "any";
  required?: boolean;
  disabled?: boolean;
};

const INPUT_CLASS = "bo-input w-full px-3 py-2 text-sm";

const parseIntegerString = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
};

function UnitNumberField<UnitId extends string>({
  name,
  value,
  onChange,
  label,
  hint,
  units,
  outputUnit,
  defaultDisplayUnit,
  resolveDisplayUnit,
  step = "any",
  required = false,
  disabled = false,
}: UnitNumberFieldProps<UnitId>) {
  const fallbackUnit = useMemo(() => units[0], [units]);
  const outputUnitOption = resolveUnit(units, outputUnit, fallbackUnit);

  const suggestedDisplayUnit = useMemo(() => {
    const parsedValue = parseIntegerString(value);
    if (parsedValue === null) {
      return defaultDisplayUnit
        ? resolveUnit(units, defaultDisplayUnit, fallbackUnit).id
        : fallbackUnit.id;
    }

    if (resolveDisplayUnit) {
      const candidate = resolveDisplayUnit({
        outputValue: parsedValue,
        outputUnit: outputUnitOption,
        units,
      });
      return resolveUnit(units, candidate, fallbackUnit).id;
    }

    const baseValue = parsedValue * outputUnitOption.factor;
    return pickReadableDisplayUnit(baseValue, units);
  }, [defaultDisplayUnit, fallbackUnit, outputUnitOption, resolveDisplayUnit, units, value]);

  const [displayUnitId, setDisplayUnitId] = useState<UnitId>(suggestedDisplayUnit);
  const [manualDisplayUnit, setManualDisplayUnit] = useState(false);

  useEffect(() => {
    if (manualDisplayUnit) {
      return;
    }

    setDisplayUnitId(suggestedDisplayUnit);
  }, [manualDisplayUnit, suggestedDisplayUnit]);

  const displayUnitOption = resolveUnit(units, displayUnitId, fallbackUnit);

  const displayValue = useMemo(() => {
    const parsedValue = parseIntegerString(value);
    if (parsedValue === null) {
      return "";
    }

    const baseValue = parsedValue * outputUnitOption.factor;
    const convertedValue = baseValue / displayUnitOption.factor;
    return formatUnitNumber(convertedValue);
  }, [displayUnitOption.factor, outputUnitOption.factor, value]);

  const handleValueChange = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value.trim();
    if (!raw) {
      onChange("");
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return;
    }

    const converted = (parsed * displayUnitOption.factor) / outputUnitOption.factor;
    if (!Number.isFinite(converted)) {
      return;
    }

    onChange(String(Math.round(converted)));
  };

  const handleUnitChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextUnit = resolveUnit(units, event.target.value as UnitId, fallbackUnit);
    setManualDisplayUnit(true);
    setDisplayUnitId(nextUnit.id);
  };

  return (
    <FormField label={label} hint={hint}>
      <input type="hidden" name={name} value={value} />
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          type="number"
          value={displayValue}
          onChange={handleValueChange}
          min={0}
          step={step}
          required={required}
          disabled={disabled}
          className="w-full"
        />
        <select
          value={displayUnitId}
          onChange={handleUnitChange}
          disabled={disabled}
          className={INPUT_CLASS}
          aria-label={`${label} unit`}
        >
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </select>
      </div>
    </FormField>
  );
}

const TIME_UNITS = [
  { id: "seconds", label: "Seconds", factor: 1 },
  { id: "minutes", label: "Minutes", factor: 60 },
  { id: "hours", label: "Hours", factor: 60 * 60 },
  { id: "days", label: "Days", factor: 60 * 60 * 24 },
] as const;

type ByteUnitId = (typeof BYTE_UNITS)[number]["id"];
type TimeUnitId = (typeof TIME_UNITS)[number]["id"];

type ByteUnitFieldProps = Omit<
  UnitNumberFieldProps<ByteUnitId>,
  "units" | "outputUnit" | "defaultDisplayUnit"
> & {
  outputUnit?: ByteUnitId;
  defaultDisplayUnit?: ByteUnitId;
};

type TimeUnitFieldProps = Omit<
  UnitNumberFieldProps<TimeUnitId>,
  "units" | "outputUnit" | "defaultDisplayUnit"
> & {
  outputUnit?: TimeUnitId;
  defaultDisplayUnit?: TimeUnitId;
};

export function ByteUnitField({
  outputUnit = "bytes",
  defaultDisplayUnit = "mb",
  ...props
}: ByteUnitFieldProps) {
  return (
    <UnitNumberField
      {...props}
      units={BYTE_UNITS}
      outputUnit={outputUnit}
      defaultDisplayUnit={defaultDisplayUnit}
    />
  );
}

export function TimeUnitField({
  outputUnit = "seconds",
  defaultDisplayUnit = "minutes",
  ...props
}: TimeUnitFieldProps) {
  return (
    <UnitNumberField
      {...props}
      units={TIME_UNITS}
      outputUnit={outputUnit}
      defaultDisplayUnit={defaultDisplayUnit}
    />
  );
}
