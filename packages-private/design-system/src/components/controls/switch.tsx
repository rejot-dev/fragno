import { Switch as BaseSwitch } from "@base-ui/react/switch";

/** A labelled on/off row for settings that apply immediately, such as view options. */
export function Switch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center justify-between gap-3 px-3 text-xs text-[var(--bo-muted)] transition-[background-color,color] duration-150 hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]">
      <span>{label}</span>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(nextChecked) => {
          onCheckedChange(nextChecked);
        }}
        className="group inline-flex h-6 w-10 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-1 transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-accent-bg)]"
      >
        <BaseSwitch.Thumb className="size-4 bg-[var(--bo-fg)] transition-transform duration-150 group-data-[checked]:translate-x-4" />
      </BaseSwitch.Root>
    </label>
  );
}
