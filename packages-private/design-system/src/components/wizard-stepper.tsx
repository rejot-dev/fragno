import { Progress } from "@base-ui/react/progress";
import { Tabs } from "@base-ui/react/tabs";

import { cn } from "../cn";
import { Icon } from "./icon";

export type WizardStep = {
  // Identifies the step within a stepper, so titles must be unique.
  title: string;
  description?: string;
  helper?: string;
};

export function WizardStepper({
  steps,
  currentStep,
  onStepChange,
}: {
  steps: WizardStep[];
  currentStep: number;
  onStepChange?: (step: number) => void;
}) {
  const totalSteps = steps.length;
  if (totalSteps === 0) {
    return (
      <div className="space-y-3">
        <div className="rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
          No steps available.
        </div>
      </div>
    );
  }
  const clampedStep = totalSteps === 0 ? 0 : Math.min(Math.max(currentStep, 0), totalSteps - 1);
  const progressValue = totalSteps === 0 ? 0 : Math.round(((clampedStep + 1) / totalSteps) * 100);
  const activeValue = String(clampedStep);

  return (
    <div className="space-y-3">
      <Progress.Root value={progressValue} className="space-y-2">
        <div className="flex items-center justify-between text-xs font-semibold text-[var(--bo-muted-2)]">
          <Progress.Label>Progress</Progress.Label>
          <Progress.Value className="text-[var(--bo-muted)] tabular-nums" />
        </div>
        <Progress.Track className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bo-panel-2)] shadow-[inset_0_0_0_1px_var(--bo-border)]">
          <Progress.Indicator className="h-full rounded-full bg-[var(--bo-accent)] transition-[width] duration-150 ease-out" />
        </Progress.Track>
      </Progress.Root>

      <Tabs.Root
        value={activeValue}
        onValueChange={(value) => onStepChange?.(Number(value))}
        className="space-y-3"
      >
        <Tabs.List className="grid gap-2 md:grid-cols-3">
          {steps.map((step, index) => {
            const isComplete = index < clampedStep;
            return (
              <Tabs.Tab
                key={step.title}
                value={String(index)}
                className={cn(
                  "cursor-pointer rounded-[4px] border p-3 text-left transition-[background-color,border-color,box-shadow] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30",
                  isComplete
                    ? "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-fg)]"
                    : "border-transparent text-[var(--bo-muted)]",
                  "data-[active]:border-[color:var(--bo-selected-border)] data-[active]:bg-[var(--bo-selected-bg)] data-[active]:shadow-[var(--bo-selected-shadow)] data-[active]:text-[var(--bo-fg)] data-[active]:hover:bg-[var(--bo-selected-bg)]",
                )}
                aria-current={index === clampedStep ? "step" : undefined}
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--bo-muted-2)]">
                  {isComplete ? (
                    <Icon name="check" className="size-3.5 text-[var(--bo-accent)]" />
                  ) : null}
                  Step {index + 1}
                </span>
                <span className="mt-1 block text-sm font-semibold text-[var(--bo-fg)]">
                  {step.title}
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        {steps.map((step, index) => (
          <Tabs.Panel
            key={step.title}
            value={String(index)}
            className="rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]"
          >
            <div className="space-y-2">
              {step.description ? <p>{step.description}</p> : null}
              {step.helper ? (
                <p className="text-xs text-[var(--bo-muted-2)]">{step.helper}</p>
              ) : null}
            </div>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </div>
  );
}
