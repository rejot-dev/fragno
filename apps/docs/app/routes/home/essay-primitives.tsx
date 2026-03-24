import { createContext, useContext } from "react";
import type { ElementType, ReactNode } from "react";

import { defaultPerspective } from "./types";
import type { PerspectiveAudience, PerspectiveState, PerspectiveTime } from "./types";

type EditorialAccentColor =
  | "paper"
  | "surface"
  | "surfaceLow"
  | "ink"
  | "muted"
  | "primary"
  | "secondary"
  | "tertiary"
  | "ghostBorder";

const editorialAccentVar: Record<EditorialAccentColor, string> = {
  paper: "var(--editorial-paper)",
  surface: "var(--editorial-surface)",
  surfaceLow: "var(--editorial-surface-low)",
  ink: "var(--editorial-ink)",
  muted: "var(--editorial-muted)",
  primary: "var(--editorial-primary)",
  secondary: "var(--editorial-secondary)",
  tertiary: "var(--editorial-tertiary)",
  ghostBorder: "var(--editorial-ghost-border)",
};

export function AccentText({
  children,
  color = "ink",
  mark = false,
  colored = false,
}: {
  children: ReactNode;
  color?: EditorialAccentColor;
  mark?: boolean;
  colored?: boolean;
}) {
  const c = editorialAccentVar[color];

  if (mark) {
    return (
      <mark
        className="rounded-sm [box-decoration-break:clone] px-[0.12em] py-px text-(--editorial-ink) no-underline"
        style={{ backgroundColor: `color-mix(in srgb, ${c} 32%, transparent)` }}
      >
        {children}
      </mark>
    );
  }

  const decorationSource = color === "ink" ? "var(--editorial-primary)" : c;

  return (
    <span
      className="underline decoration-2 underline-offset-[0.18em]"
      style={{
        color: colored ? c : undefined,
        textDecorationColor: `color-mix(in srgb, ${decorationSource} 45%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

type PerspectiveContextValue = {
  perspective: PerspectiveState;
  committedPerspective: PerspectiveState;
  motionKey: number;
};

const PerspectiveContext = createContext<PerspectiveContextValue>({
  perspective: defaultPerspective,
  committedPerspective: defaultPerspective,
  motionKey: 0,
});

export function PerspectiveProvider({
  value,
  children,
}: {
  value: PerspectiveContextValue;
  children: ReactNode;
}) {
  return <PerspectiveContext.Provider value={value}>{children}</PerspectiveContext.Provider>;
}

function usePerspective() {
  return useContext(PerspectiveContext);
}

function compareTime(selected: PerspectiveTime, minimum: PerspectiveTime) {
  const rank = { low: 1, medium: 2, high: 3 } as const;
  return rank[selected] >= rank[minimum];
}

function isAudienceMatch(selected: PerspectiveAudience, audience: PerspectiveAudience) {
  if (selected === "both" || audience === "both") {
    return true;
  }
  return selected === audience;
}

export function PerspectiveFocus({
  children,
  audience = "both",
  minimumTime = "low",
  className,
  as: Component = "div",
}: {
  children: ReactNode;
  audience?: PerspectiveAudience;
  minimumTime?: PerspectiveTime;
  className?: string;
  as?: ElementType;
}) {
  const { perspective, motionKey } = usePerspective();
  const isRelevant =
    isAudienceMatch(perspective.audience, audience) && compareTime(perspective.time, minimumTime);

  return (
    <Component
      key={`${motionKey}-${String(isRelevant)}`}
      data-active={isRelevant}
      data-motion-key={motionKey}
      className={className}
      style={{
        opacity: isRelevant ? 1 : 0.18,
        filter: isRelevant ? "blur(0px) saturate(1)" : "blur(0.35px) saturate(0.58)",
        transform: isRelevant ? "translateY(0) scale(1)" : "translateY(3px) scale(0.99)",
        transition:
          "opacity 340ms cubic-bezier(0.22, 1, 0.36, 1), filter 340ms cubic-bezier(0.22, 1, 0.36, 1), transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
        animation: `perspective-muted-${isRelevant ? "in" : "out"} 260ms cubic-bezier(0.22, 1, 0.36, 1)`,
      }}
    >
      {children}
    </Component>
  );
}
