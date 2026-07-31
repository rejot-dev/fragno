export type DiagnosticValueShapeOptions = {
  keyLimit: number;
  stringLimit: number;
  discriminatorPaths: readonly (readonly string[])[];
};

export function truncateDiagnosticString(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

export function describeDiagnosticValue(
  value: unknown,
  options: DiagnosticValueShapeOptions,
): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(length=${value.length})`;
  }
  if (value instanceof Date) {
    return "date";
  }
  if (typeof value === "string") {
    return `string(characters=${value.length})`;
  }
  if (typeof value !== "object") {
    return typeof value;
  }

  try {
    const record = value as Record<string, unknown>;
    const discriminators = options.discriminatorPaths
      .map((path) => diagnosticStringAtPath(record, path, options.stringLimit))
      .filter((entry): entry is string => entry !== undefined);
    const keys = Object.keys(record).slice(0, options.keyLimit);

    return `object(keys=${keys.join(",")}${
      discriminators.length > 0 ? `; ${discriminators.join(", ")}` : ""
    })`;
  } catch {
    return "uninspectable-object";
  }
}

function diagnosticStringAtPath(
  value: Record<string, unknown>,
  path: readonly string[],
  stringLimit: number,
): string | undefined {
  let current: unknown = value;
  for (const property of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[property];
  }

  return typeof current === "string"
    ? `${path.join(".")}=${truncateDiagnosticString(current, stringLimit)}`
    : undefined;
}
