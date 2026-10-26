import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";

import { cn } from "../cn";

export type RadioCardOption<TValue extends string> = {
  value: TValue;
  label: string;
  description: string;
};

/**
 * Picks one of a few options, each a selectable card with a sentence explaining it. With a name it
 * submits the chosen value with its form.
 */
export function RadioCards<TValue extends string>({
  label,
  name,
  value,
  options,
  onValueChange,
}: {
  /** Names the group for screen readers. */
  label: string;
  name: string;
  value: TValue;
  options: readonly RadioCardOption<TValue>[];
  onValueChange: (value: TValue) => void;
}) {
  return (
    <RadioGroup
      aria-label={label}
      name={name}
      value={value}
      onValueChange={(next) => {
        onValueChange(next);
      }}
      className="grid gap-2"
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex min-h-14 cursor-pointer items-start gap-3 rounded-[4px] border px-4 py-3.5 text-sm transition-[border-color,background-color] duration-150 ease-out",
            option.value === value
              ? "border-[color:var(--bo-accent)] bg-[var(--bo-selected-bg)] shadow-[var(--bo-selected-shadow)]"
              : "border-[color:var(--bo-border)] bg-[var(--bo-panel)] hover:border-[color:var(--bo-border-strong)]",
          )}
        >
          <Radio.Root
            value={option.value}
            className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] transition-[border-color] duration-150 ease-out outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 data-[checked]:border-[color:var(--bo-accent)]"
          >
            <Radio.Indicator className="size-2 rounded-full bg-[var(--bo-accent)]" />
          </Radio.Root>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-[var(--bo-fg)]">{option.label}</span>
            <span className="mt-1 block text-xs leading-5 text-pretty text-[var(--bo-muted)]">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
