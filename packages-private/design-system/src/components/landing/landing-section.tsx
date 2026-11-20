import type { ReactNode } from "react";

/** A section's heading and the explanation under it, for sections that lay out their own visual. */
export const LANDING_SECTION_TITLE_CLASS_NAME =
  "font-heading max-w-4xl text-[clamp(2rem,3.6vw,3.25rem)] leading-[1.05] font-light tracking-[-0.06em] text-balance";
export const LANDING_SECTION_INTRO_CLASS_NAME =
  "mt-6 max-w-2xl text-base leading-7 text-pretty text-[var(--bo-muted)]";

/**
 * A landing page section: its heading, its explanation underneath, and the visual that shows the
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
      <h2 id={id} className={LANDING_SECTION_TITLE_CLASS_NAME}>
        {title}
      </h2>
      <p className={LANDING_SECTION_INTRO_CLASS_NAME}>{children}</p>
      <div className="mt-10">{visual}</div>
    </section>
  );
}

/**
 * The frame around a section's visual: a rounded card, like the hero's, lifted off the page by a
 * soft shadow. The visual sets its own background and overflow.
 */
export const LANDING_FRAME_CLASS_NAME =
  "rounded-[14px] border border-[color:var(--bo-border)] shadow-[0_1px_2px_rgb(11_11_10/0.06),0_24px_48px_-24px_rgb(11_11_10/0.3)]";

/** A framed stage for a section's visual, set on the second panel color like the app's canvas. */
export function LandingStage({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 sm:p-5">
      {children}
    </div>
  );
}

/** The homepage's content column, which the header and the hero's grid lines line up with. */
export function LandingColumn({ children }: { children: ReactNode }) {
  return <div className="max-w-landing mx-auto w-full px-7 sm:px-8 lg:px-12">{children}</div>;
}

/** Lays sections out the way the landing page does, so stories show their real spacing. */
export function LandingPageColumn({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-landing mx-auto w-full space-y-28 px-5 py-16 sm:px-8 lg:px-12 lg:py-24">
      {children}
    </div>
  );
}
