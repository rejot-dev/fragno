import { Progress } from "@base-ui/react/progress";
import { Tabs } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

export type WizardStep = {
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
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
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
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
          <Progress.Label>Progress</Progress.Label>
          <Progress.Value className="text-[var(--bo-muted)]" />
        </div>
        <Progress.Track className="h-2 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]">
          <Progress.Indicator className="h-full bg-[var(--bo-accent)]" />
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
                key={`${step.title}-${index}`}
                value={String(index)}
                className={cn(
                  "border p-3 text-left transition-colors",
                  isComplete
                    ? "border-[color:var(--bo-border-strong)] bg-[var(--bo-panel-2)] text-[var(--bo-fg)]"
                    : "border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted)]",
                  "data-[active]:border-[color:var(--bo-accent)] data-[active]:bg-[var(--bo-accent-bg)] data-[active]:text-[var(--bo-accent-fg)]",
                )}
                aria-current={index === clampedStep ? "step" : undefined}
              >
                <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  Step {index + 1}
                </span>
                <span className="mt-2 block text-sm font-semibold text-[var(--bo-fg)]">
                  {step.title}
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>

        {steps.map((step, index) => (
          <Tabs.Panel
            key={`${step.title}-panel-${index}`}
            value={String(index)}
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]"
          >
            <div className="space-y-2">
              {step.description ? <p>{step.description}</p> : null}
              {step.helper ? (
                <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                  {step.helper}
                </p>
              ) : null}
            </div>
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </div>
  );
}
