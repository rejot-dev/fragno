import { cn } from "../../cn";
import { PillArrow, PillButtonLink, PillLabel } from "../controls/pill-button";
import { LandingDemo } from "./demo";

/** The homepage's opening: what Backoffice does, the two ways in, and the product doing it. */
export function LandingHero() {
  return (
    <section className="max-w-landing mx-auto w-full px-5 pt-14 pb-20 sm:px-8 lg:px-12 lg:pt-24 lg:pb-28">
      <h1 className="max-w-[1040px] text-[clamp(3.5rem,8.8vw,8.4rem)] leading-[0.88] font-[560] tracking-[-0.075em] text-balance">
        AI that shows
        <br />
        <span className="text-[var(--bo-muted-2)]">its work.</span>
      </h1>
      <p className="mt-9 max-w-2xl text-[clamp(0.95rem,1.4vw,1.1rem)] leading-7 text-pretty text-[var(--bo-muted)]">
        Describe how your business runs, and Leyway writes it as workflows you can read. They run
        the same way every time, ask before they act, and record every step.
      </p>
      <LandingCallsToAction className="mt-10" />
      <div className="mt-16 lg:mt-20">
        <LandingDemo />
      </div>
    </section>
  );
}

// What stays true however the work was described, each something the reader can check.
const PROMISES = [
  { title: "You can read it.", text: "Every workflow is code, step by step." },
  { title: "It asks first.", text: "A run stops for you before it acts." },
  { title: "It keeps a record.", text: "Every step, answer, and failure is traced." },
  { title: "Your data stays put.", text: "In the EU or the US, chosen once." },
] as const;

/** Closes the page on its point of view, then repeats the ways in. */
export function LandingClosing() {
  return (
    <section aria-labelledby="landing-closing">
      <h2
        id="landing-closing"
        className="font-heading max-w-4xl text-[clamp(3rem,7vw,7rem)] leading-[0.92] font-light tracking-[-0.06em] text-balance"
      >
        AI is a tool,
        <br />
        not a co-worker.
      </h2>
      <ul className="mt-14 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
        {PROMISES.map((promise) => (
          <li
            key={promise.title}
            className="border-t border-[color-mix(in_srgb,var(--bo-fg)_35%,transparent)] pt-4"
          >
            <p className="font-heading text-2xl font-normal tracking-[-0.04em]">{promise.title}</p>
            <p className="mt-2 text-sm leading-6 text-[var(--bo-muted)]">{promise.text}</p>
          </li>
        ))}
      </ul>
      <LandingCallsToAction className="mt-14" />
    </section>
  );
}

// The hero's buttons: one solid way in, in the page's ink on its background, and an outlined second.
function LandingCallsToAction({ className }: { className: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <PillButtonLink to="/backoffice/sign-up" variant="filled" size="default" ring={false}>
        <PillLabel>Get started</PillLabel>
        <PillArrow />
      </PillButtonLink>
      <PillButtonLink to="/marketplace" variant="outlined" size="default" ring={false}>
        <PillLabel>Browse the marketplace</PillLabel>
      </PillButtonLink>
    </div>
  );
}
