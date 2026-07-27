/** Explicit scope for workflow steps executed outside the runner's local async context. */
export type WorkflowStepIdentity = {
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
};

export type WorkflowStepKeySegment = {
  type: string;
  name: string;
  occurrence: number;
};

export type ParsedWorkflowStepKey = {
  segments: WorkflowStepKeySegment[];
  parentStepKey: string | null;
};

export const ROOT_STEP_SCOPE = "$root";
export const NESTED_STEP_SEPARATOR = ">";

const STEP_TYPE_SEPARATOR = ":";
const STEP_OCCURRENCE_SEPARATOR = "#";
const STEP_NAME_RESERVED_CHARS = [NESTED_STEP_SEPARATOR, STEP_OCCURRENCE_SEPARATOR, "\u0000"];

const assertStepNameIsDelimiterSafe = (name: string) => {
  const reservedChar = STEP_NAME_RESERVED_CHARS.find((char) => name.includes(char));
  if (reservedChar) {
    throw new Error(`WORKFLOW_STEP_NAME_CONTAINS_RESERVED_CHARACTER:${reservedChar}`);
  }
};

const assertLocalStepKeyIsDelimiterSafe = (stepKey: string) => {
  if (stepKey.includes(NESTED_STEP_SEPARATOR)) {
    throw new Error("WORKFLOW_STEP_KEY_CONTAINS_NESTED_SEPARATOR");
  }
};

/**
 * Build a deterministic step key from type, name, and optional occurrence.
 * Bigger picture: stable step keys are the identity for replayable workflow steps.
 */
export function buildStepKey(type: string, name: string, occurrence?: number): string {
  assertStepNameIsDelimiterSafe(name);
  const base = `${type}${STEP_TYPE_SEPARATOR}${name}`;
  if (occurrence === undefined || occurrence === 0) {
    return base;
  }
  return `${base}${STEP_OCCURRENCE_SEPARATOR}${occurrence}`;
}

export function buildNestedStepKey(parentStepKey: string, childStepKey: string): string {
  assertLocalStepKeyIsDelimiterSafe(childStepKey);
  return `${parentStepKey}${NESTED_STEP_SEPARATOR}${childStepKey}`;
}

export function parseStepKey(stepKey: string): ParsedWorkflowStepKey {
  const localStepKeys = stepKey.split(NESTED_STEP_SEPARATOR);
  const segments = localStepKeys.map(parseLocalStepKey);

  return {
    segments,
    parentStepKey:
      localStepKeys.length === 1 ? null : localStepKeys.slice(0, -1).join(NESTED_STEP_SEPARATOR),
  };
}

export function getOutermostStepKey(stepKey: string): string {
  return stepKey.split(NESTED_STEP_SEPARATOR)[0];
}

function parseLocalStepKey(localStepKey: string): WorkflowStepKeySegment {
  const typeSeparatorIndex = localStepKey.indexOf(STEP_TYPE_SEPARATOR);
  if (typeSeparatorIndex < 1) {
    throw new Error("INVALID_WORKFLOW_STEP_KEY");
  }

  const type = localStepKey.slice(0, typeSeparatorIndex);
  const nameWithOccurrence = localStepKey.slice(typeSeparatorIndex + 1);
  const occurrenceSeparatorIndex = nameWithOccurrence.lastIndexOf(STEP_OCCURRENCE_SEPARATOR);
  if (occurrenceSeparatorIndex < 0) {
    if (nameWithOccurrence.includes("\u0000")) {
      throw new Error("INVALID_WORKFLOW_STEP_KEY");
    }
    return { type, name: nameWithOccurrence, occurrence: 0 };
  }

  const name = nameWithOccurrence.slice(0, occurrenceSeparatorIndex);
  const occurrenceText = nameWithOccurrence.slice(occurrenceSeparatorIndex + 1);
  const occurrence = Number(occurrenceText);
  if (
    name.includes(STEP_OCCURRENCE_SEPARATOR) ||
    name.includes("\u0000") ||
    !/^\d+$/u.test(occurrenceText) ||
    !Number.isSafeInteger(occurrence)
  ) {
    throw new Error("INVALID_WORKFLOW_STEP_KEY");
  }

  return { type, name, occurrence };
}
