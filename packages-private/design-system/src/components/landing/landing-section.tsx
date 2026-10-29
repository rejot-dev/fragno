import type { ReactNode } from "react";

/**
 * A landing page section: its heading and explanation side by side above the visual that shows the
 * feature. `id` names the heading, so the section is announced by it.
 */
export function LandingSection({
  id,
  title,
  children,
  visual,
}: {
  id: string;
  title: string;
  children: ReactNode;
  visual: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="grid gap-8 lg:grid-cols-[0.42fr_0.58fr] lg:items-end">
        <h2
          id={id}
          className="max-w-md text-[clamp(2.25rem,4.4vw,4.25rem)] leading-[0.96] font-[560] tracking-[-0.055em] text-balance"
        >
          {title}
        </h2>
        <p className="max-w-xl text-sm leading-7 text-pretty text-[var(--bo-muted)] lg:justify-self-end">
          {children}
        </p>
      </div>
      <div className="mt-10">{visual}</div>
    </section>
  );
}

/** A framed stage for a section's visual, set on the second panel color like the app's canvas. */
export function LandingStage({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 sm:p-5">
      {children}
    </div>
  );
}

/** Lays sections out the way the landing page does, so stories show their real spacing. */
export function LandingPageColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-28 px-5 py-16 sm:px-8 lg:px-12 lg:py-24">
      {children}
    </div>
  );
}
