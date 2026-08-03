export function hasVisibleWorkflowOutput(value: unknown): boolean {
  const visibleValue = withoutTopLevelGeneratedUi(value);
  if (visibleValue === undefined || visibleValue === null) {
    return false;
  }
  if (Array.isArray(visibleValue)) {
    return visibleValue.length > 0;
  }
  if (isRecord(visibleValue)) {
    return Object.keys(visibleValue).length > 0;
  }
  return true;
}

export function serializeWorkflowOutput(value: unknown): string {
  const visibleValue = withoutTopLevelGeneratedUi(value);
  if (visibleValue === undefined) {
    return "undefined";
  }
  try {
    return JSON.stringify(visibleValue, null, 2) ?? String(visibleValue);
  } catch {
    return String(visibleValue);
  }
}

function withoutTopLevelGeneratedUi(value: unknown): unknown {
  if (!isRecord(value) || !("$ui" in value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ui"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
