import { LeywayMark } from "@fragno-private/design-system/brand/leyway-mark";
import { LeywayWordmark } from "@fragno-private/design-system/brand/leyway-wordmark";
import { Icon } from "@fragno-private/design-system/icon";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { useScrolled } from "./use-scrolled";

// Mirrors the cells of the app's top bar, aligned to the page's content column. Every cell hugs
// its item with the same padding. Once the page scrolls under the header, lines frame the cells and
// the hero continues them downward; from md up, the hero's lines follow the cells' measured widths.
const containerClassName = "mx-auto w-full max-w-landing px-7 sm:px-8 lg:px-12";
// The hero draws its lines in its own ink, faintly, so they recede behind whatever it shows.
const heroLineClassName = "border-current/8";
// From md up, the cells reach this far past the content column on either side, so their outer
// lines frame the hero's copy with the same room the logo and the last link get inside them.
const outsetClassName = "md:-mx-4";
// The header publishes its columns here, on the document, for the hero's lines to follow.
const COLUMNS_PROPERTY = "--landing-header-columns";

// Once the page scrolls, faint lines in the header's ink frame its cells, over dark surfaces only;
// over light ones the header shows just its items.
const cellSeparatorClassName =
  "border-transparent transition-[color,border-color,background-color] duration-400 ease-out group-data-[scrolled]/header:group-data-[over-dark]/header:border-[color-mix(in_srgb,var(--landing-header-ink)_12%,transparent)]";
const navCellBaseClassName = `group/link flex items-center gap-2 whitespace-nowrap ${cellSeparatorClassName} text-sm no-underline outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset`;
// Links rest a shade lighter than the ink and darken to it on hover.
const navCellClassName = `${navCellBaseClassName} font-light text-[color-mix(in_srgb,var(--landing-header-ink)_68%,transparent)] hover:text-[var(--landing-header-ink)]`;

/**
 * Whether what shows under the header belongs to one of the page's dark surfaces, the elements
 * marked `data-landing-dark`. It looks at the edge the page scrolls in under: the bottom one going
 * down, the top one going up, so the header turns as soon as a new surface reaches it. It asks for
 * the topmost element there rather than which surface spans it, so the dashboard rising over the
 * hero counts as light. It starts over the hero, which is dark.
 */
function useOverDarkSurface(headerRef: RefObject<HTMLElement | null>) {
  const [overDarkSurface, setOverDarkSurface] = useState(true);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) {
      return undefined;
    }
    let lastScrollY = window.scrollY;
    const updateOverDarkSurface = () => {
      const { top, bottom, left, right } = header.getBoundingClientRect();
      const scrollingUp = window.scrollY < lastScrollY;
      lastScrollY = window.scrollY;
      // Just inside the edge, so the header's own border is not what is asked about.
      const edge = scrollingUp ? top + 1 : bottom - 2;
      const below = document
        .elementsFromPoint((left + right) / 2, edge)
        .find((element) => !header.contains(element));
      setOverDarkSurface(below?.closest("[data-landing-dark]") != null);
    };
    updateOverDarkSurface();
    window.addEventListener("scroll", updateOverDarkSurface, { passive: true });
    window.addEventListener("resize", updateOverDarkSurface);
    return () => {
      window.removeEventListener("scroll", updateOverDarkSurface);
      window.removeEventListener("resize", updateOverDarkSurface);
    };
  }, [headerRef]);
  return overDarkSurface;
}

/** Publishes the widths of the header's logo and link cells, for the hero to line up with. */
function usePublishedColumns() {
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return undefined;
    }
    const cells = [...grid.querySelectorAll<HTMLElement>("[data-header-cell]")];
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      // The first column is the logo's; only the cells in the grid's flow make columns.
      const [logo, ...links] = cells
        .filter((cell) => {
          const style = getComputedStyle(cell);
          return style.display !== "none" && style.position !== "absolute";
        })
        .map((cell) => `${cell.getBoundingClientRect().width}px`);
      root.style.setProperty(COLUMNS_PROPERTY, `${logo} minmax(0,1fr) ${links.join(" ")}`);
    });
    cells.forEach((cell) => {
      observer.observe(cell);
    });
    return () => {
      observer.disconnect();
      root.style.removeProperty(COLUMNS_PROPERTY);
    };
  }, []);
  return gridRef;
}

/** Provides the public Leyway product header, Marketplace link, and app entry point. */
export function LandingHeader() {
  const scrolled = useScrolled();
  const gridRef = usePublishedColumns();
  const headerRef = useRef<HTMLElement>(null);
  const overDarkSurface = useOverDarkSurface(headerRef);

  return (
    // Clear with white ink over the page's dark surfaces, blurring what lies behind it so its
    // items stay legible over the hero's photo and copy. White with black ink over light surfaces,
    // in both themes.
    <header
      ref={headerRef}
      data-scrolled={scrolled || undefined}
      data-over-dark={overDarkSurface || undefined}
      className="group/header sticky top-0 z-30 border-b border-transparent bg-white transition-[border-color,box-shadow,background-color] duration-400 ease-out [--landing-header-ink:#0b0b0a] data-[over-dark]:bg-transparent data-[over-dark]:backdrop-blur-md data-[over-dark]:[--landing-header-ink:#ffffff] data-[scrolled]:border-[color-mix(in_srgb,var(--landing-header-ink)_8%,transparent)] data-[scrolled]:not-data-[over-dark]:shadow-[0_10px_30px_-20px_rgba(11,11,10,0.15)]"
    >
      <div className={containerClassName}>
        <div
          ref={gridRef}
          className={`relative grid h-16 grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto_auto] ${outsetClassName}`}
        >
          <Link
            to="/"
            data-header-cell
            // The first cell, at the start. From md up it is framed on both sides, so its lines run on
            // into the hero's column lines.
            className={`flex min-w-0 items-center gap-3 border-r pr-4 no-underline outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset max-[379px]:pr-2.5 md:border-l md:pl-4 ${cellSeparatorClassName}`}
            aria-label="Leyway home"
          >
            <LeywayMark className="h-[calc(var(--spacing)*9*480/920)] w-auto max-[439px]:h-[calc(var(--spacing)*7*480/920)]" />
            <LeywayWordmark className="h-9 text-[var(--landing-header-ink)] transition-[color] duration-400 ease-out max-[439px]:h-7" />
          </Link>
          {/* Phones fit the logo and both links only with a smaller logo, and the narrowest only
              with tighter cells and no arrow too. */}
          <nav aria-label="Product" className="col-span-2 col-start-3 grid grid-cols-subgrid">
            <Link
              to="/marketplace"
              data-header-cell
              className={`${navCellClassName} border-l px-4 max-[379px]:px-2.5`}
            >
              Marketplace
            </Link>
            <Link
              to="/backoffice"
              data-header-cell
              // The header's one call to action: a cell like the others, framed on both sides from md
              // up like the logo's, holding an outlined round button in the header's ink, like the
              // hero's Browse the marketplace. On hover, a ring in the logo's colors runs around it
              // (landing.css); over the hero it also lightens, while on the white header it stays
              // white.
              className={`${navCellBaseClassName} border-l px-4 max-[379px]:px-2.5 md:border-r`}
            >
              <span className="landing-rainbow-ring inline-flex h-12 items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--landing-header-ink)_30%,transparent)] px-6 text-sm font-semibold text-[var(--landing-header-ink)] transition-colors duration-150 group-data-[over-dark]/header:group-hover/link:bg-[color-mix(in_srgb,var(--landing-header-ink)_10%,transparent)] max-[379px]:px-3">
                {/* The font's ascent is far taller than its caps, so an untrimmed line box centers
                    the letters low. Trimmed to cap height and baseline, the letters center in the
                    button and on the arrow, as in every round button on the page. */}
                <span className="[text-box:trim-both_cap_alphabetic]">Open app</span>
                <Icon
                  name="arrow-right"
                  className="size-3.5 transition-transform duration-150 group-hover/link:translate-x-0.5 max-[379px]:hidden"
                />
              </span>
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

/**
 * Lays its children out on the header's columns from md up: the logo's, the free middle, and one
 * per link. Place it across the page's content column. `className` adds to the grid, such as how it
 * lays out below md.
 */
function LandingColumns({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={`md:grid md:grid-cols-[var(--landing-header-columns)] ${outsetClassName} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The header's column lines, continued down the section this fills. Place it under the section's
 * copy and over its artwork, in a `group/hero` that carries `data-scrolled` once the page scrolls.
 */
export function LandingColumnLines() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 hidden opacity-0 transition-opacity duration-300 ease-out group-data-[scrolled]/hero:opacity-100 md:block"
    >
      <div className={`${containerClassName} h-full`}>
        <LandingColumns className="h-full">
          <span className={`border-x ${heroLineClassName}`} />
          <span />
          <span className={`border-l ${heroLineClassName}`} />
          <span className={`border-x ${heroLineClassName}`} />
        </LandingColumns>
      </div>
    </div>
  );
}
