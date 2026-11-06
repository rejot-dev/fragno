import type { ReactNode } from "react";

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
      <h2
        id={id}
        className="font-heading max-w-4xl text-[clamp(2.25rem,4.4vw,4.25rem)] leading-[1.05] font-light tracking-[-0.06em] text-balance"
      >
        {title}
      </h2>
      <p className="mt-6 max-w-2xl text-base leading-7 text-pretty text-[var(--bo-muted)]">
        {children}
      </p>
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

/** Lays sections out the way the landing page does, so stories show their real spacing. */
export function LandingPageColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-28 px-5 py-16 sm:px-8 lg:px-12 lg:py-24">
      {children}
    </div>
  );
}
