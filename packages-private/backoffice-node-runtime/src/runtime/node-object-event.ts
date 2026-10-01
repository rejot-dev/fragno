/** Settles an object's output dependency before exposing either its result or handler error. */
export async function runNodeObjectEvent<TResult>(
  operation: () => TResult | Promise<TResult>,
  settleOutputDependency: () => void,
): Promise<TResult> {
  let outcome: { kind: "success"; value: TResult } | { kind: "failure"; error: unknown };
  try {
    outcome = { kind: "success", value: await operation() };
  } catch (error) {
    outcome = { kind: "failure", error };
  }

  settleOutputDependency();
  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.value;
}
