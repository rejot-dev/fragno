import { Select as BaseSelect } from "@base-ui/react/select";

type SelectOption = {
  // null hides the secondary line under the option label.
  description: string | null;
  label: string;
  value: string;
};

type SelectProps = {
  label: string;
  name: string;
  options: SelectOption[];
  placeholder: string;
  value: string;
  onValueChange: (value: string) => void;
};

// Labelled single-value picker that submits with its surrounding form under `name`.
export function Select({ label, name, options, placeholder, value, onValueChange }: SelectProps) {
  const items = options.map((option) => ({ label: option.label, value: option.value }));

  return (
    <div className="min-w-0">
      <BaseSelect.Root
        name={name}
        required
        items={items}
        value={value || null}
        disabled={options.length === 0}
        onValueChange={(nextValue) => {
          if (nextValue !== null) {
            onValueChange(nextValue);
          }
        }}
      >
        <BaseSelect.Label className="mb-1.5 block text-[10px] font-semibold tracking-[0.12em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </BaseSelect.Label>
        <BaseSelect.Trigger className="bo-input group flex min-h-11 w-full min-w-0 cursor-pointer items-stretch overflow-hidden text-left data-[disabled]:cursor-not-allowed">
          <BaseSelect.Value
            placeholder={placeholder}
            className="flex min-w-0 flex-1 items-center truncate px-3 text-sm font-medium text-[var(--bo-fg)]"
          />
          <span className="inline-flex flex-none items-center border-l border-[color:var(--bo-border)] px-2.5 text-[9px] font-semibold tracking-[0.1em] text-[var(--bo-muted-2)] uppercase transition-colors duration-150 group-hover:text-[var(--bo-fg)]">
            Change
          </span>
        </BaseSelect.Trigger>

        <BaseSelect.Portal>
          <BaseSelect.Positioner
            align="start"
            alignItemWithTrigger={false}
            sideOffset={6}
            className="z-50 w-[var(--anchor-width)] max-w-[min(24rem,var(--available-width))] min-w-56"
          >
            <BaseSelect.Popup
              data-backoffice-root
              className="bo-popover-surface w-full origin-[var(--transform-origin)] overflow-hidden border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-fg)] transition-[opacity,transform] duration-150 ease-out data-[ending-style]:translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0"
            >
              <BaseSelect.List className="backoffice-scroll max-h-72 overflow-y-auto p-1">
                {options.map((option) => (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    className="group/item grid min-h-11 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border border-transparent px-3 py-2 text-sm text-[var(--bo-muted)] transition-[background-color,border-color,color] duration-100 outline-none select-none data-[highlighted]:border-[color:var(--bo-border)] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)] data-[selected]:text-[var(--bo-fg)]"
                  >
                    <span className="min-w-0">
                      <BaseSelect.ItemText className="block truncate font-medium">
                        {option.label}
                      </BaseSelect.ItemText>
                      {option.description !== null ? (
                        <span className="mt-0.5 block truncate text-[10px] text-[var(--bo-muted-2)]">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    <BaseSelect.ItemIndicator className="text-[9px] font-semibold tracking-[0.1em] text-[var(--bo-accent-fg)] uppercase">
                      Current
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
}
