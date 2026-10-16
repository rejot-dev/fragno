import { Select as BaseSelect } from "@base-ui/react/select";

import { cn } from "../cn";
import { fieldDensityClassNames, type FieldDensity } from "./field-density";
import { Icon } from "./icon";

type SelectOption<TValue> = { label: string; value: TValue };

// Single-value picker on the shared .bo-input surface. Inside a Field it takes the field's label;
// outside one, name it with aria-label. With a name it submits the chosen value with its form.
// A value matching no option shows the placeholder.
export function Select<TValue>({
  "aria-label": ariaLabel,
  className,
  defaultValue,
  density = "default",
  disabled = false,
  name,
  options,
  placeholder = "Choose an option",
  required = false,
  value,
  onValueChange,
}: {
  "aria-label"?: string;
  className?: string;
  defaultValue?: TValue | null;
  density?: FieldDensity;
  disabled?: boolean;
  name?: string;
  options: readonly SelectOption<TValue>[];
  placeholder?: string;
  required?: boolean;
  value?: TValue | null;
  onValueChange?: (value: TValue | null) => void;
}) {
  const matchOption = (candidate: TValue | null | undefined) =>
    options.some((option) => Object.is(option.value, candidate)) ? candidate : null;

  return (
    <BaseSelect.Root
      items={options}
      name={name}
      value={value === undefined ? undefined : matchOption(value)}
      defaultValue={defaultValue === undefined ? undefined : matchOption(defaultValue)}
      disabled={disabled}
      required={required}
      itemToStringLabel={(itemValue) =>
        options.find((option) => Object.is(option.value, itemValue))?.label ?? String(itemValue)
      }
      itemToStringValue={(itemValue) => String(itemValue)}
      onValueChange={(nextValue) => onValueChange?.(nextValue)}
    >
      <BaseSelect.Trigger
        aria-label={ariaLabel}
        className={cn(
          "bo-input group flex w-full cursor-pointer items-center gap-2 text-left data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          fieldDensityClassNames(density).control,
          className,
        )}
      >
        <BaseSelect.Value placeholder={placeholder} className="min-w-0 flex-1 truncate" />
        <Icon
          name="chevron-down"
          className="size-4 shrink-0 text-[var(--bo-muted-2)] transition-[color,rotate] duration-150 ease-out group-hover:text-[var(--bo-fg)] group-data-[popup-open]:rotate-180"
          strokeWidth={1.75}
        />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={4}
          align="start"
          alignItemWithTrigger={false}
          className="z-50 w-[var(--anchor-width)] max-w-[var(--available-width)] min-w-52"
        >
          <BaseSelect.Popup
            data-backoffice-root
            className="bo-popover-surface flex max-h-72 origin-[var(--transform-origin)] flex-col gap-0.5 overflow-y-auto rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-1.5 text-[var(--bo-fg)] transition-[opacity,scale] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
          >
            {options.map((option) => (
              <BaseSelect.Item
                key={`${option.label}-${String(option.value)}`}
                value={option.value}
                className={cn(
                  "grid cursor-pointer grid-cols-[1fr_auto] items-center gap-3 rounded-[4px] px-2.5 py-2 font-medium text-[var(--bo-fg)] transition-[background-color,box-shadow] duration-150 ease-out outline-none data-[highlighted]:bg-[var(--bo-panel-2)] data-[selected]:bg-[var(--bo-selected-bg)] data-[selected]:shadow-[var(--bo-selected-shadow)]",
                  density === "compact" ? "min-h-9 text-xs" : "min-h-10 text-sm",
                )}
              >
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator>
                  <Icon name="check" className="size-4 text-[var(--bo-accent)]" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
