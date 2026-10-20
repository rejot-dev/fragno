import { useState } from "react";

import { RadioMenu, type RadioMenuOption } from "./radio-menu";

export default { title: "Controls/Radio menu" };

type Display = "ui" | "simple" | "code";

const DISPLAY_OPTIONS: RadioMenuOption<Display>[] = [
  { value: "ui", label: "UI", description: null, icon: "layout", disabled: false },
  { value: "simple", label: "Flow", description: null, icon: "list", disabled: false },
  { value: "code", label: "Code", description: null, icon: "code", disabled: false },
];

type ComposerAction = "message" | "compact";

const ACTION_OPTIONS: RadioMenuOption<ComposerAction>[] = [
  {
    value: "message",
    label: "Send message",
    description: "Start or continue the conversation",
    icon: null,
    disabled: false,
  },
  {
    value: "compact",
    label: "Compact context",
    description: "Unavailable while the agent is working",
    icon: null,
    disabled: true,
  },
];

export function ToolbarControl() {
  const [display, setDisplay] = useState<Display>("simple");
  return (
    <div className="flex items-center gap-3 text-xs text-[var(--bo-muted)]">
      <RadioMenu
        label="Workflow display options"
        heading={null}
        trigger={{ kind: "control", icon: "more-horizontal" }}
        side="bottom"
        value={display}
        options={DISPLAY_OPTIONS}
        onValueChange={setDisplay}
      />
      Showing {display}
    </div>
  );
}

export function SplitButtonHalf() {
  const [action, setAction] = useState<ComposerAction>("message");
  return (
    <div className="flex h-80 items-end justify-end">
      <div className="flex items-stretch">
        <span className="inline-flex min-h-10 items-center border border-r-0 border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-4 text-xs font-semibold text-[var(--bo-accent-fg)]">
          {action === "compact" ? "Compact" : "Send"}
        </span>
        <RadioMenu
          label="Choose composer action"
          heading="Composer action"
          trigger={{ kind: "accent" }}
          side="top"
          value={action}
          options={ACTION_OPTIONS}
          onValueChange={setAction}
        />
      </div>
    </div>
  );
}
