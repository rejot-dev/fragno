export default { title: "Foundations/Palette" };

// Mirrors the colour tokens in theme.css. Tokens that hold channel triples or shadows are left out
// because they are not paintable on their own.
const GROUPS: { title: string; tokens: string[] }[] = [
  {
    title: "Brand",
    tokens: ["--primary", "--primary-foreground", "--ring", "--destructive"],
  },
  {
    title: "Surfaces",
    tokens: [
      "--bo-bg",
      "--bo-sidebar-bg",
      "--bo-header-bg",
      "--bo-panel",
      "--bo-panel-2",
      "--bo-selected-bg",
      "--bo-selected-border",
      "--bo-border",
      "--bo-border-strong",
    ],
  },
  {
    title: "Text",
    tokens: ["--bo-fg", "--bo-muted", "--bo-muted-2"],
  },
  {
    title: "Accent & buttons",
    tokens: [
      "--bo-accent",
      "--bo-accent-strong",
      "--bo-accent-bg",
      "--bo-accent-fg",
      "--bo-btn-bg",
      "--bo-btn-bg-hover",
      "--bo-btn-fg",
    ],
  },
  {
    title: "Blues",
    tokens: ["--bo-blue-1", "--bo-blue-2", "--bo-blue-3", "--bo-blue-4"],
  },
  {
    title: "Status",
    tokens: [
      "--bo-live",
      "--bo-live-bg",
      "--bo-waiting",
      "--bo-waiting-bg",
      "--bo-failed",
      "--bo-failed-bg",
    ],
  },
  {
    title: "Charts",
    tokens: ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"],
  },
  {
    title: "Base theme",
    tokens: [
      "--background",
      "--foreground",
      "--card",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--border",
      "--sidebar",
      "--sidebar-accent",
    ],
  },
];

export function Palette() {
  return (
    <div className="flex flex-col gap-10">
      {GROUPS.map((group) => (
        <section key={group.title} className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">{group.title}</h2>
          <div className="flex flex-wrap gap-5">
            {group.tokens.map((token) => (
              <figure key={token} className="flex w-32 flex-col gap-2">
                <div
                  className="size-32 rounded-[4px] shadow-[var(--bo-panel-shadow)]"
                  style={{ background: `var(${token})` }}
                />
                <figcaption className="font-mono text-xs text-[var(--bo-muted)]">
                  {token}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
