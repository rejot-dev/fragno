export type RuntimeScenarioStepKind = "given" | "when" | "then" | "concurrent" | "alarm" | "clock";

/** One labeled scenario operation executed against a concrete runtime context. */
export type RuntimeScenarioStep<TContext> = {
  kind: RuntimeScenarioStepKind;
  label: string;
  run(context: TContext): void | Promise<void>;
};

/** Builds narrative setup, action, assertion, and concurrent scenario steps. */
export type RuntimeScenarioStepBuilders<TContext> = {
  given(label: string, run: RuntimeScenarioStep<TContext>["run"]): RuntimeScenarioStep<TContext>;
  when(label: string, run: RuntimeScenarioStep<TContext>["run"]): RuntimeScenarioStep<TContext>;
  then(label: string, run: RuntimeScenarioStep<TContext>["run"]): RuntimeScenarioStep<TContext>;
  concurrent(...steps: RuntimeScenarioStep<TContext>[]): RuntimeScenarioStep<TContext>;
};

/** Creates one runtime scenario step with its label and behavior colocated. */
export function defineRuntimeScenarioStep<TContext>(
  kind: RuntimeScenarioStepKind,
  label: string,
  run: RuntimeScenarioStep<TContext>["run"],
): RuntimeScenarioStep<TContext> {
  return { kind, label, run };
}

/** Creates the common narrative builders shared by local and Graft runtime scenarios. */
export function createRuntimeScenarioStepBuilders<TContext>(
  concurrentFailureMessage: string,
): RuntimeScenarioStepBuilders<TContext> {
  return {
    given: (label, run) => defineRuntimeScenarioStep("given", label, run),
    when: (label, run) => defineRuntimeScenarioStep("when", label, run),
    // oxlint-disable-next-line no-thenable -- `then` names an assertion step, not a Promise callback.
    then: (label, run) => defineRuntimeScenarioStep("then", label, run),
    concurrent: (...steps) =>
      defineRuntimeScenarioStep(
        "concurrent",
        steps.map(({ label }) => label).join(" | "),
        async (context) => {
          const branches = await Promise.allSettled(
            steps.map(async (branch) => {
              await branch.run(context);
            }),
          );
          const failures = branches.flatMap((branch) =>
            branch.status === "rejected" ? [branch.reason as unknown] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(failures, concurrentFailureMessage);
          }
        },
      ),
  };
}

/** Executes runtime scenario steps in order and reports the labeled journal on success. */
export async function runRuntimeScenarioSteps<TContext>(options: {
  name: string;
  context: TContext;
  steps: readonly RuntimeScenarioStep<TContext>[];
  stepFailurePrefix: string;
}): Promise<{ journal: { kind: RuntimeScenarioStepKind; label: string }[] }> {
  const journal: { kind: RuntimeScenarioStepKind; label: string }[] = [];
  for (const currentStep of options.steps) {
    try {
      await currentStep.run(options.context);
      journal.push({ kind: currentStep.kind, label: currentStep.label });
    } catch (cause) {
      throw new Error(`${options.stepFailurePrefix}:${options.name}:${currentStep.label}`, {
        cause,
      });
    }
  }
  return { journal };
}
