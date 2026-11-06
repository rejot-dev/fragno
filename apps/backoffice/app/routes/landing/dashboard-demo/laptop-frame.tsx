import { useEffect, useRef, useState, type ReactNode } from "react";

// The screen's content renders at this small desktop size and is scaled to the screen, so it looks
// like the app on a laptop whatever the visitor's viewport is, with text large enough to read.
const SCREEN_WIDTH = 1000;
const SCREEN_HEIGHT = 625;

// Space grey aluminium: cool against the hero's warm amber, so it stands out.
const aluminiumClassName = "bg-[linear-gradient(180deg,#a3a5aa,#86888d_55%,#6c6e73)]";

/**
 * A front-facing laptop whose screen shows `children` as a picture: the content cannot be focused
 * or clicked, and assistive technology reads `label` instead.
 */
export function LaptopFrame({ label, children }: { label: string; children: ReactNode }) {
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

  // Sizes are in container widths, so every part of the laptop keeps its proportions.
  return (
    <figure role="img" aria-label={label} className="@container w-full">
      <div
        className={`mx-auto w-[86cqw] rounded-t-[2.4cqw] rounded-b-[0.5cqw] p-[0.3cqw] shadow-[0_0.4cqw_1.2cqw_rgba(11,11,10,0.1),0_2.5cqw_6cqw_-1.5cqw_rgba(11,11,10,0.22)] ${aluminiumClassName}`}
      >
        <div className="relative rounded-t-[2.1cqw] rounded-b-[0.3cqw] bg-[linear-gradient(180deg,#0b0b0b_calc(100%-1.7cqw),#232323_calc(100%-1.7cqw))] px-[1.5cqw] pt-[1.9cqw] pb-[3.3cqw]">
          <span className="absolute top-[0.75cqw] left-1/2 size-[0.45cqw] -translate-x-1/2 rounded-full bg-[#1c2230]" />
          <div
            ref={screenRef}
            className="relative aspect-[16/10] overflow-hidden rounded-[0.4cqw] bg-[var(--bo-bg)]"
          >
            <div
              inert
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
            </div>
          </div>
        </div>
      </div>
      <div
        className={`relative h-[1.5cqw] rounded-t-[0.25cqw] rounded-b-[1.6cqw] shadow-[0_1.2cqw_2cqw_-0.8cqw_rgba(0,0,0,0.35)] ${aluminiumClassName}`}
      >
        {/* The notch that lifts the lid. */}
        <span className="absolute top-0 left-1/2 h-[0.65cqw] w-[15cqw] -translate-x-1/2 rounded-b-[0.8cqw] bg-[linear-gradient(180deg,#5d5f63,#808287)]" />
      </div>
      {/* The faint shadow it casts on what it rests on. */}
      <div
        aria-hidden="true"
        className="mx-auto -mt-[0.5cqw] h-[2.6cqw] w-[96cqw] rounded-[50%] bg-[radial-gradient(closest-side,rgba(11,11,10,0.22),transparent)]"
      />
    </figure>
  );
}
