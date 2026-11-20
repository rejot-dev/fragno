import { VelocityLogo } from "./velocity-logo";

/**
 * The partners who set Leyway up with a business, as a strip of muted logo tiles under a short
 * heading. Each logo links to the partner's site and takes its own colors on hover.
 */
export function LandingPartners() {
  return (
    <section aria-labelledby="landing-partners">
      <h2
        id="landing-partners"
        className="font-heading text-center text-xl font-light tracking-[-0.02em] text-balance sm:text-2xl"
      >
        Set up with our partners
      </h2>
      {/* Tiles keep a sixth of the row however few there are, centered, so a short list still
          reads as part of a wall of logos. */}
      <ul className="mt-12 flex flex-wrap justify-center gap-1.5">
        <li className="basis-[calc(50%-0.1875rem)] sm:basis-[calc((100%-0.75rem)/3)] lg:basis-[calc((100%-1.875rem)/6)]">
          <a
            href="https://www.velocity-ai.nl/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Velocity"
            className="group flex h-24 items-center justify-center bg-[color-mix(in_srgb,var(--bo-fg)_3%,var(--bo-bg))] no-underline transition-colors duration-150 outline-none hover:bg-[color-mix(in_srgb,var(--bo-fg)_5%,var(--bo-bg))] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30"
          >
            <VelocityLogo tone="muted" />
          </a>
        </li>
      </ul>
    </section>
  );
}
