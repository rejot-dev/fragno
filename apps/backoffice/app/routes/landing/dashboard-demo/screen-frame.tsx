import { useEffect, useRef, useState, type ReactNode } from "react";

// The screen's content renders at this small desktop size and is scaled to the screen, so it looks
// like the app on a desktop whatever the visitor's viewport is, with text large enough to read.
const SCREEN_WIDTH = 1000;
const SCREEN_HEIGHT = 625;

/**
 * A glossy screen that shows `children` as a picture: the content cannot be focused or clicked, and
 * assistive technology reads `label` instead. `bar` runs along the screen's bottom edge and stays
 * interactive. The gloss lies over the content at z-30, so content layered above that, such as a
 * shade dimming what is out of focus, covers the gloss too.
 */
export function ScreenFrame({
  label,
  bar,
  children,
}: {
  label: string;
  bar: ReactNode;
  children: ReactNode;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      setScale(screen.clientWidth / SCREEN_WIDTH);
    });
    observer.observe(screen);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Sizes are in container widths, so the screen keeps its proportions.
  return (
    <div className="@container w-full">
      {/* A low block resting on the page: a hard edge straight below, without blur like the app's
          selected-item shadow, reads as its side, in the border color so it shows in either theme;
          a faint soft shadow under it sets it down. */}
      <div className="relative mx-auto w-[88cqw] overflow-hidden rounded-[1cqw] shadow-[0_0.5cqw_0_0_var(--bo-border),0_0.6cqw_1.6cqw_-0.2cqw_rgba(11,11,10,0.08)]">
        {/* The bar sits outside the figure: inside an image, its controls would be hidden from
            assistive technology. */}
        <figure
          ref={screenRef}
          role="img"
          aria-label={label}
          className="relative aspect-[16/10] overflow-hidden bg-[var(--bo-bg)]"
        >
          <div
            inert
            className="relative"
            style={{
              width: SCREEN_WIDTH,
              height: SCREEN_HEIGHT,
              transform: `scale(${scale ?? 1})`,
              transformOrigin: "top left",
              // Unscaled, the content would flash at full size until the screen is measured.
              visibility: scale === null ? "hidden" : "visible",
            }}
          >
            {children}
            {/* The gloss: a sheen across the left with a hard glare edge, slanted like the logo's
                mark (12.34 degrees off vertical, so the gradient runs that far past horizontal).
                The dashboard is nearly white, so the glass past the sheen is faintly tinted;
                otherwise the sheen would not show against it. It sits inside the content's layers
                rather than over the screen, so a shade dims the sheen with what is under it and
                the part in focus stays the brightest. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-30 bg-[linear-gradient(102.34deg,rgba(255,255,255,0.3)_0%,rgba(255,255,255,0.1)_20%,rgba(11,11,10,0.03)_20.3%,rgba(11,11,10,0.05)_100%)]"
            />
          </div>
        </figure>
        {/* In the app's sidebar color, so the bar reads as part of the screen rather than a strip
            under it. */}
        <div className="border-t border-(--bo-border) bg-(--bo-sidebar-bg)">{bar}</div>
      </div>
    </div>
  );
}
