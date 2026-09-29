import { Button, ButtonLink, type ButtonVariant, IconButton } from "./button";
import { Icon } from "./icon";

export default { title: "Controls/Button" };

const VARIANTS: { variant: ButtonVariant; label: string; description: string }[] = [
  {
    variant: "solid",
    label: "Install",
    description: "Primary colour. The page-level call to action; use at most one per page.",
  },
  {
    variant: "accent",
    label: "Save changes",
    description: "Tinted primary. The default action inside a form, panel, or dialog.",
  },
  {
    variant: "secondary",
    label: "Cancel",
    description: "Raised neutral surface. Alternative actions next to the default one.",
  },
  {
    variant: "ghost",
    label: "Skip",
    description: "No surface until hover. Low-emphasis actions and toolbars.",
  },
];

export function Variants() {
  return (
    <div className="flex flex-col gap-5">
      {VARIANTS.map(({ variant, label, description }) => (
        <div key={variant} className="flex items-center gap-6">
          <div className="w-36 shrink-0">
            <Button variant={variant}>{label}</Button>
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

export function WithIcons() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="accent">
        <Icon name="plus" className="size-4" />
        New automation
      </Button>
      <Button variant="secondary">
        <Icon name="refresh-cw" className="size-4" />
        Refresh
      </Button>
    </div>
  );
}

export function Disabled() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="accent" disabled>
        Save changes
      </Button>
      <Button variant="secondary" disabled>
        Cancel
      </Button>
      <Button variant="ghost" disabled>
        Skip
      </Button>
      <Button variant="solid" disabled>
        Install
      </Button>
    </div>
  );
}

export function Links() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ButtonLink variant="accent" to="/automations/new">
        Create automation
      </ButtonLink>
      <ButtonLink variant="secondary" to="/automations">
        Back to list
      </ButtonLink>
    </div>
  );
}

export function IconButtons() {
  return (
    <div className="flex items-center gap-1">
      <IconButton label="Settings">
        <Icon name="settings" className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Refresh">
        <Icon name="refresh-cw" className="size-4" strokeWidth={1.75} />
      </IconButton>
      <IconButton label="Delete" disabled>
        <Icon name="trash-2" className="size-4" strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}
