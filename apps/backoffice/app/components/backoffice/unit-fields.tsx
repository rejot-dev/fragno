import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import { FormField } from "./form-container";

type UnitOption<UnitId extends string> = {
  id: UnitId;
  label: string;
  factor: number;
};

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

const INPUT_CLASS =
  "focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2";

const SELECT_CLASS =
  "focus:ring-[color:var(--bo-accent)]/20 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)] focus:border-[color:var(--bo-accent)] focus:outline-none focus:ring-2";

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

const formatUnitNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return "";
  }

  if (Number.isInteger(value)) {
    return String(value);
  }

  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }

  return value.toFixed(2).replace(/\.?0+$/, "");
};

const pickReadableDisplayUnit = <UnitId extends string>(
  baseValue: number,
  units: readonly UnitOption<UnitId>[],
) => {
  let chosen = units[0];
  for (const unit of units) {
    if (baseValue >= unit.factor) {
      chosen = unit;
    }
  }
  return chosen.id;
};

const resolveUnit = <UnitId extends string>(
  units: readonly UnitOption<UnitId>[],
  unitId: UnitId,
  fallback: UnitOption<UnitId>,
) => {
  return units.find((unit) => unit.id === unitId) ?? fallback;
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
        <input
          type="number"
          value={displayValue}
          onChange={handleValueChange}
          min={0}
          step={step}
          required={required}
          disabled={disabled}
          className={INPUT_CLASS}
        />
        <select
          value={displayUnitId}
          onChange={handleUnitChange}
          disabled={disabled}
          className={SELECT_CLASS}
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

const BYTE_UNITS = [
  { id: "bytes", label: "Bytes", factor: 1 },
  { id: "kb", label: "KB", factor: 1024 },
  { id: "mb", label: "MB", factor: 1024 ** 2 },
  { id: "gb", label: "GB", factor: 1024 ** 3 },
  { id: "tb", label: "TB", factor: 1024 ** 4 },
] as const;

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

const formatUsingUnits = <UnitId extends string>(
  value: number,
  units: readonly UnitOption<UnitId>[],
  outputUnit: UnitId,
) => {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }

  const fallbackUnit = units[0];
  const outputUnitOption = resolveUnit(units, outputUnit, fallbackUnit);
  const baseValue = value * outputUnitOption.factor;
  const displayUnitId = pickReadableDisplayUnit(baseValue, units);
  const displayUnit = resolveUnit(units, displayUnitId, fallbackUnit);
  const convertedValue = baseValue / displayUnit.factor;
  return `${formatUnitNumber(convertedValue)} ${displayUnit.label}`;
};

export const formatBytes = (value: number) => formatUsingUnits(value, BYTE_UNITS, "bytes");

export const formatDuration = (valueSeconds: number) =>
  formatUsingUnits(valueSeconds, TIME_UNITS, "seconds");

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
