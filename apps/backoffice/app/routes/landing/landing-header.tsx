import { LeywayMark } from "@fragno-private/design-system/brand/leyway-mark";
import { LeywayWordmark } from "@fragno-private/design-system/brand/leyway-wordmark";
import { cn } from "@fragno-private/design-system/cn";
import { PillLabel, pillClassName } from "@fragno-private/design-system/controls/pill-button";
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
 * Whether the header lies wholly over one of the page's dark surfaces, the elements marked
 * `data-landing-dark`. It asks about both its edges, and only when both are over a dark surface
 * does it go clear with white ink; while it straddles a light and a dark surface it stays white
 * with black ink, which reads over either. So it turns white as soon as a light surface reaches
 * it, and clear only once the dark one has passed behind all of it. At each edge it asks for the
 * topmost element rather than which surface spans it, so the dashboard rising over the hero counts
 * as light. Until it can look, which is not before hydration, it takes the page's word for what
 * the top of the page is, so the header renders legibly from the first paint.
 *
 * Over a dark surface the document takes the surface's color too. iOS paints the strip it keeps
 * beside or above a home-screen web app, where the iPhone Duo shows the time, in the document's
 * color, so the strip then reads as part of the hero rather than a light bar beside it.
 */
function useOverDarkSurface(headerRef: RefObject<HTMLElement | null>, startsOverDark: boolean) {
  const [overDarkSurface, setOverDarkSurface] = useState(startsOverDark);
  useEffect(() => {
    const header = headerRef.current;
    if (!header) {
      return undefined;
    }
    const darkSurfaceAt = (x: number, y: number) =>
      document
        .elementsFromPoint(x, y)
        .find((element) => !header.contains(element))
        ?.closest("[data-landing-dark]") ?? null;
    const updateOverDarkSurface = () => {
      const { top, bottom, left, right } = header.getBoundingClientRect();
      const middle = (left + right) / 2;
      // Just inside each edge, so the header's own border is not what is asked about.
      const surface = darkSurfaceAt(middle, top + 1);
      const over = surface !== null && darkSurfaceAt(middle, bottom - 2) !== null;
      setOverDarkSurface(over);
      paintDocument(over ? getComputedStyle(surface).backgroundColor : "");
    };
    updateOverDarkSurface();
    window.addEventListener("scroll", updateOverDarkSurface, { passive: true });
    window.addEventListener("resize", updateOverDarkSurface);
    return () => {
      window.removeEventListener("scroll", updateOverDarkSurface);
      window.removeEventListener("resize", updateOverDarkSurface);
      paintDocument("");
    };
  }, [headerRef]);
  return overDarkSurface;
}

/** Sets the document's background color, or with "" returns it to the theme's. */
function paintDocument(color: string) {
  // iOS takes the body's color, or the root's where the body has none; the page covers both.
  document.documentElement.style.backgroundColor = color;
  document.body.style.backgroundColor = color;
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

/**
 * Provides the public Leyway product header, Marketplace link, and app entry point.
 * `startsOverDark` says whether the page opens on a dark surface marked `data-landing-dark`.
 * `nav` is the product's links and entry point, or, on pages that are already the way into the
 * app, only the way back home.
 */
export function LandingHeader({
  startsOverDark,
  nav,
}: {
  startsOverDark: boolean;
  nav: "product" | "back-home";
}) {
  const scrolled = useScrolled();
  const gridRef = usePublishedColumns();
  const headerRef = useRef<HTMLElement>(null);
  const overDarkSurface = useOverDarkSurface(headerRef, startsOverDark);

  return (
    // Clear with white ink over the page's dark surfaces, blurring what lies behind it so its
    // items stay legible over the hero's photo and copy. White with black ink over light surfaces,
    // in both themes.
    <header
      ref={headerRef}
      data-scrolled={scrolled || undefined}
      data-over-dark={overDarkSurface || undefined}
      className="group/header sticky top-0 z-30 border-b border-transparent bg-white transition-[border-color,background-color] duration-400 ease-out [--landing-header-ink:#0b0b0a] data-[over-dark]:bg-transparent data-[over-dark]:backdrop-blur-md data-[over-dark]:[--landing-header-ink:#ffffff] data-[scrolled]:border-[color-mix(in_srgb,var(--landing-header-ink)_8%,transparent)]"
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
          {nav === "product" ? (
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
                // hero's Browse the marketplace. On hover, a ring in the logo's colors runs around it;
                // over the hero it also lightens, while on the white header it stays white.
                className={`${navCellBaseClassName} border-l px-4 max-[379px]:px-2.5 md:border-r`}
              >
                <span
                  className={cn(
                    pillClassName({ variant: "outlined", size: "default", ring: true }),
                    "[--bo-fg:var(--landing-header-ink)] group-data-[over-dark]/header:group-hover/link:bg-[color-mix(in_srgb,var(--landing-header-ink)_10%,transparent)] max-[379px]:px-3",
                  )}
                >
                  <PillLabel>Open app</PillLabel>
                  <Icon
                    name="arrow-right"
                    className="size-3.5 transition-transform duration-150 group-hover/link:translate-x-0.5 max-[379px]:hidden"
                  />
                </span>
              </Link>
            </nav>
          ) : (
            // A single cell in the last column, framed on both sides from md up like the logo's.
            <nav aria-label="Back" className="col-start-4">
              <Link
                to="/"
                data-header-cell
                className={`${navCellClassName} h-full border-l px-4 max-[379px]:px-2.5 md:border-r`}
              >
                <Icon
                  name="arrow-left"
                  className="size-3.5 transition-transform duration-150 group-hover/link:-translate-x-0.5"
                />
                Back to home
              </Link>
            </nav>
          )}
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
