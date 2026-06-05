/** Explicit scope for workflow steps executed outside the runner's local async context. */
export type WorkflowStepIdentity = {
  stepKey: string;
  parentStepKey: string | null;
  depth: number;
};

export const ROOT_STEP_SCOPE = "$root";
export const NESTED_STEP_SEPARATOR = ">";

/**
 * Build a deterministic step key from type, name, and optional occurrence.
 * Bigger picture: stable step keys are the identity for replayable workflow steps.
 */
export function buildStepKey(type: string, name: string, occurrence?: number): string {
  const base = `${type}:${name}`;
  if (occurrence === undefined || occurrence === 0) {
    return base;
  }
  return `${base}#${occurrence}`;
}

export function buildNestedStepKey(parentStepKey: string, childStepKey: string): string {
  return `${parentStepKey}${NESTED_STEP_SEPARATOR}${childStepKey}`;
}

export function getOutermostStepKey(stepKey: string): string {
  return stepKey.split(NESTED_STEP_SEPARATOR)[0]!;
}
