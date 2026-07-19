/** Explicit scope for workflow steps executed outside the runner's local async context. */
export type WorkflowStepIdentity = {
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
};

export const ROOT_STEP_SCOPE = "$root";
export const NESTED_STEP_SEPARATOR = ">";

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
  const base = `${type}:${name}`;
  if (occurrence === undefined || occurrence === 0) {
    return base;
  }
  return `${base}${STEP_OCCURRENCE_SEPARATOR}${occurrence}`;
}

export function buildNestedStepKey(parentStepKey: string, childStepKey: string): string {
  assertLocalStepKeyIsDelimiterSafe(childStepKey);
  return `${parentStepKey}${NESTED_STEP_SEPARATOR}${childStepKey}`;
}

export function getOutermostStepKey(stepKey: string): string {
  return stepKey.split(NESTED_STEP_SEPARATOR)[0];
}
