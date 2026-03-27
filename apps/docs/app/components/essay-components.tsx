import type { ReactNode } from "react";
import { useState } from "react";

import { FragnoCodeBlock } from "@/components/fragno-code-block";

export const P = ({ children }: { children: ReactNode }) => (
  <p className="mb-6 max-w-4xl text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
    {children}
  </p>
);

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-(--editorial-surface-low) p-1 font-mono">{children}</code>
);

export function EssayHeader({
  volumeLine,
  title,
  author,
  authorMeta,
}: {
  volumeLine: ReactNode;
  title: ReactNode;
  author: ReactNode;
  authorMeta: ReactNode;
}) {
  return (
    <header className="mb-18 max-w-4xl">
      <div className="mb-6 text-base font-bold tracking-[0.14em] text-(--editorial-primary) uppercase">
        {volumeLine}
      </div>
      <h1 className="text-5xl leading-[0.96] font-bold tracking-[-0.045em] md:text-7xl">{title}</h1>
      <div className="mt-8 flex items-center gap-4 text-base tracking-[0.15em] text-(--editorial-muted) uppercase">
        <span className="text-(--editorial-ink)">{author}</span>
        <span className="h-6 w-px bg-(--editorial-ghost-border)" aria-hidden />
        <span>{authorMeta}</span>
      </div>
    </header>
  );
}

export function EssayCodeFigure({
  code,
  lang,
  caption,
}: {
  code: string;
  lang: string;
  caption: string;
}) {
  return (
    <figure className="my-12 max-w-4xl space-y-6">
      <div className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] shadow-[0_24px_48px_rgb(15_23_42/0.08)] backdrop-blur-md dark:shadow-[0_24px_48px_rgb(2_6_23/0.28)]">
        <div className="p-6 md:p-10">
          <FragnoCodeBlock
            lang={lang}
            code={code}
            syntaxTheme="editorial-triad"
            className="bg-[color-mix(in_srgb,var(--editorial-surface-low)_88%,var(--editorial-ink)_4%)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] dark:bg-(--editorial-surface-low)!"
            allowCopy
          />
        </div>
      </div>
      <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
        {caption}
      </figcaption>
    </figure>
  );
}

export type TabbedCodeFigureTab = {
  id: string;
  label: string;
  color: "primary" | "secondary" | "tertiary";
  headline: string;
  description: string | ReactNode;
  snippets: { label: string; code: string; lang: string }[];
};

const TAB_COLOR_VAR: Record<TabbedCodeFigureTab["color"], string> = {
  primary: "var(--editorial-primary)",
  secondary: "var(--editorial-secondary)",
  tertiary: "var(--editorial-tertiary)",
};

export function TabbedCodeFigure({
  tabs,
  figcaption,
  ariaLabel,
}: {
  tabs: TabbedCodeFigureTab[];
  figcaption: string;
  ariaLabel: string;
}) {
  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  if (!activeTab) {
    return null;
  }

  const accentVar = TAB_COLOR_VAR[activeTab.color];

  return (
    <figure className="mb-12 max-w-4xl space-y-6">
      <div className="overflow-hidden bg-[color-mix(in_srgb,var(--editorial-surface)_84%,transparent)] shadow-[0_24px_48px_rgb(15_23_42/0.08)] backdrop-blur-[12px] dark:shadow-[0_24px_48px_rgb(2_6_23_/_0.28)]">
        <div
          className="flex flex-wrap gap-4 bg-[color-mix(in_srgb,var(--editorial-surface-low)_92%,transparent)] px-6 py-4 text-base font-bold tracking-[0.14em] uppercase md:px-10"
          role="tablist"
          aria-label={ariaLabel}
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTabId(tab.id)}
                className={`transition-colors ${
                  isActive
                    ? `text-[${TAB_COLOR_VAR[tab.color]}] underline decoration-2 underline-offset-[0.65rem]`
                    : "text-(--editorial-muted) hover:text-(--editorial-ink)"
                }`}
                style={isActive ? { color: TAB_COLOR_VAR[tab.color] } : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="space-y-6 p-6 md:p-10">
          <div className="max-w-4xl space-y-4">
            <div
              className="text-base font-bold tracking-[0.14em] uppercase"
              style={{ color: accentVar }}
            >
              {activeTab.headline}
            </div>
            <p className="text-base leading-[1.8] text-[color-mix(in_srgb,var(--editorial-ink)_70%,white)]">
              {activeTab.description}
            </p>
          </div>

          <div className="space-y-5">
            {activeTab.snippets.map((snippet) => (
              <div key={snippet.label} className="space-y-2">
                <div
                  className="text-xs font-bold tracking-[0.14em] uppercase"
                  style={{ color: accentVar }}
                >
                  {snippet.label}
                </div>
                <FragnoCodeBlock
                  lang={snippet.lang}
                  code={snippet.code}
                  syntaxTheme="editorial-triad"
                  className="bg-[color-mix(in_srgb,var(--editorial-surface-low)_88%,var(--editorial-ink)_4%)]! shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)] dark:bg-[var(--editorial-surface-low)]!"
                  allowCopy
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <figcaption className="max-w-4xl text-base font-medium text-(--editorial-muted)">
        {figcaption}
      </figcaption>
    </figure>
  );
}
