// compact fits controls embedded in dense panels such as generated workflow UIs, default is the
// in-app form size, and comfortable suits standalone pages such as public form responses.
export type FieldDensity = "compact" | "default" | "comfortable";

const DENSITY: Record<
  FieldDensity,
  { stack: string; label: string; description: string; control: string }
> = {
  compact: {
    stack: "space-y-1.5",
    label: "text-xs",
    description: "text-[11px] leading-4",
    control: "min-h-10 px-3 text-xs",
  },
  default: {
    stack: "space-y-2",
    label: "text-sm",
    description: "text-xs leading-5",
    control: "min-h-11 px-3 text-sm",
  },
  comfortable: {
    stack: "space-y-2.5",
    label: "text-sm",
    description: "text-xs leading-5",
    control: "min-h-12 px-4 text-[15px]",
  },
};

/** Type sizes of a field's parts, and the height and padding of a control on .bo-input. */
export function fieldDensityClassNames(density: FieldDensity) {
  return DENSITY[density];
}
