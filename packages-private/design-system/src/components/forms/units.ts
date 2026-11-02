export type UnitOption<UnitId extends string> = {
  id: UnitId;
  label: string;
  factor: number;
};

export const formatUnitNumber = (value: number) => {
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

export const pickReadableDisplayUnit = <UnitId extends string>(
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

export const resolveUnit = <UnitId extends string>(
  units: readonly UnitOption<UnitId>[],
  unitId: UnitId,
  fallback: UnitOption<UnitId>,
) => {
  return units.find((unit) => unit.id === unitId) ?? fallback;
};

export const BYTE_UNITS = [
  { id: "bytes", label: "Bytes", factor: 1 },
  { id: "kb", label: "KB", factor: 1024 },
  { id: "mb", label: "MB", factor: 1024 ** 2 },
  { id: "gb", label: "GB", factor: 1024 ** 3 },
  { id: "tb", label: "TB", factor: 1024 ** 4 },
] as const;

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
