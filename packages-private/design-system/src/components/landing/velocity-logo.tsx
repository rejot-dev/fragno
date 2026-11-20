// Per tone, the name's color and the triangle's: "muted" is grey until a surrounding `group` is
// hovered, when it takes Velocity's colors, for a wall of partner logos; "brand" is in Velocity's
// colors throughout.
const TONE_CLASS_NAMES = {
  muted: {
    name: "text-[var(--bo-muted-2)] group-hover:text-[var(--bo-fg)]",
    mark: "bg-current group-hover:bg-[#2038c7]",
  },
  brand: { name: "text-[var(--bo-fg)]", mark: "bg-[#2038c7]" },
} satisfies Record<string, { name: string; mark: string }>;

/**
 * Velocity's wordmark: a cobalt triangle and the name. Their display face is not one we ship, so the
 * name is set in our sans at its heaviest weight. Decorative: the link around it carries the name.
 */
export function VelocityLogo({ tone }: { tone: keyof typeof TONE_CLASS_NAMES }) {
  const toneClassNames = TONE_CLASS_NAMES[tone];
  return (
    <span
      aria-hidden="true"
      className={`flex items-center gap-2 text-lg font-extrabold tracking-[-0.02em] transition-colors duration-150 ${toneClassNames.name}`}
    >
      <span
        className={`block size-3 transition-colors duration-150 [clip-path:polygon(0_0,100%_0,50%_100%)] ${toneClassNames.mark}`}
      />
      Velocity
    </span>
  );
}
