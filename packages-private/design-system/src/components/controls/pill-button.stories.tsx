import { PillArrow, PillButton, PillButtonLink, PillLabel, type PillVariant } from "./pill-button";

export default { title: "Controls/Pill Button" };

const VARIANTS: { variant: PillVariant; label: string; description: string }[] = [
  {
    variant: "filled",
    label: "Get started",
    description: "In the page's ink. The one way in a view leads with.",
  },
  {
    variant: "outlined",
    label: "Browse the marketplace",
    description: "Every other way forward, tinted on hover.",
  },
];

export function Variants() {
  return (
    <div className="flex flex-col gap-5">
      {VARIANTS.map(({ variant, label, description }) => (
        <div key={variant} className="flex items-center gap-6">
          <div className="w-64 shrink-0">
            <PillButton variant={variant} size="default" ring={false}>
              <PillLabel>{label}</PillLabel>
              <PillArrow />
            </PillButton>
          </div>
          <div className="flex flex-col gap-0.5">
            <code className="font-mono text-xs font-semibold">variant="{variant}"</code>
            <p className="text-sm text-[var(--bo-muted)]">{description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Ring() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PillButton variant="outlined" size="default" ring={true}>
        <PillLabel>Sign in</PillLabel>
        <PillArrow />
      </PillButton>
      <PillButton variant="filled" size="default" ring={true}>
        <PillLabel>Open app</PillLabel>
        <PillArrow />
      </PillButton>
    </div>
  );
}

export function Sizes() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PillButton variant="filled" size="default" ring={false}>
        <PillLabel>Default</PillLabel>
      </PillButton>
      <PillButton variant="filled" size="compact" ring={false}>
        <PillLabel>Compact</PillLabel>
        <PillArrow />
      </PillButton>
    </div>
  );
}

/** On a dark surface the pills follow the ink it sets, here white on the hero's film gray. */
export function OnDarkSurface() {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[14px] bg-[#232322] p-8 [--bo-bg:#0b0b0a] [--bo-fg:#ffffff]">
      <PillButtonLink to="/backoffice" variant="filled" size="default" ring={false}>
        <PillLabel>Open app</PillLabel>
        <PillArrow />
      </PillButtonLink>
      <PillButtonLink to="/marketplace" variant="outlined" size="default" ring={true}>
        <PillLabel>Browse the marketplace</PillLabel>
      </PillButtonLink>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PillButton variant="filled" size="default" ring={false} disabled>
        <PillLabel>Signing in…</PillLabel>
      </PillButton>
      <PillButton variant="outlined" size="default" ring={false} disabled>
        <PillLabel>Redirecting…</PillLabel>
      </PillButton>
    </div>
  );
}
