import { Icon } from "@fragno-private/design-system/icon";
import { memo, useEffect, useRef, useState } from "react";

import { DashboardDemo } from "./dashboard-demo";
import type { DashboardDemoState } from "./dashboard-demo-state";
import {
  DASHBOARD_DEMOS,
  durationOf,
  type DashboardDemoScene,
  sceneAt,
} from "./dashboard-demo-story";
import { ScreenFrame } from "./screen-frame";

// The timeline in the bottom bar redraws as a story plays; the dashboard redraws only when its scene changes.
const StillDashboardDemo = memo(DashboardDemo);

// Longer than any frame of a playing page, shorter than any part.
const MAX_FRAME_GAP_MS = 100;

/**
 * The dashboard demo in a glossy screen, playing its story's parts one after another on a loop while it
 * is on screen, and pausing where it is when it scrolls away. In its bottom bar, the story's timeline, a
 * segment per part; choosing one plays that part from its start. It plays for viewers who prefer
 * reduced motion too: still, it would not show how Leyway works.
 */
export function DashboardDemoPlayer({ state }: { state: DashboardDemoState }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef({ index: 0, elapsed: 0 });
  const [scene, setScene] = useState(() => sceneAt(0, 0));
  const [timeline, setTimeline] = useState({ index: 0, progress: 0 });

  const show = (index: number, elapsed: number) => {
    const next = sceneAt(index, elapsed);
    setScene((current) => (sameScene(current, next) ? current : next));
    // Coarse steps are smooth enough for a thin bar, and spare most frames a render.
    const progress = Math.floor((elapsed / durationOf(index)) * 200) / 200;
    setTimeline((current) =>
      current.index === index && current.progress === progress ? current : { index, progress },
    );
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    let lastFrameAt: number | null = null;
    let frame: number | null = null;
    const tick = (time: number) => {
      const playhead = playheadRef.current;
      if (lastFrameAt !== null) {
        // Browsers stop drawing frames in background tabs, so the first frame back can come
        // minutes later. Playing all that time at once would flick through a part per frame;
        // a gap that long is a pause, as when the dashboard scrolls away.
        playhead.elapsed += Math.min(time - lastFrameAt, MAX_FRAME_GAP_MS);
        if (playhead.elapsed >= durationOf(playhead.index)) {
          playhead.elapsed -= durationOf(playhead.index);
          playhead.index = (playhead.index + 1) % DASHBOARD_DEMOS.length;
        }
      }
      lastFrameAt = time;
      show(playhead.index, playhead.elapsed);
      frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && frame === null) {
          lastFrameAt = null;
          frame = requestAnimationFrame(tick);
        } else if (!entry?.isIntersecting && frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  return (
    <div ref={containerRef} data-ignores-reduced-motion>
      <ScreenFrame
        label="The Leyway dashboard, in one story: someone asks the agent to connect Google Drive and Slack, then for a page of this week's signups, then to tell #sales on Slack about every Business signup."
        // One timeline for the one story, in a segment per part.
        bar={
          <ol className="flex">
            {DASHBOARD_DEMOS.map((demo, index) => {
              const fill =
                index < timeline.index ? 1 : index === timeline.index ? timeline.progress : 0;
              const active = index === timeline.index;
              // Sections interlock: each after the first slides back under its neighbor's slant,
              // and the bar's ends stay square so the sections fill it from edge to edge.
              const first = index === 0;
              const last = index === DASHBOARD_DEMOS.length - 1;
              const clipPath = `polygon(${first ? "0" : "0.625rem"} 0,100% 0,${last ? "100%" : "calc(100% - 0.625rem)"} 100%,0 100%)`;
              return (
                <li key={demo.id} className={`min-w-0 flex-1 ${first ? "" : "-ml-[0.625rem]"}`}>
                  <button
                    type="button"
                    aria-current={active ? "step" : undefined}
                    onClick={() => {
                      playheadRef.current = { index, elapsed: 0 };
                      show(index, 0);
                    }}
                    style={{ clipPath }}
                    // Slanted sections like the header's call to action, in light ink for the dark
                    // bar; the part playing is a shade brighter. The slant clips a ring, so focus
                    // shows as the brightest fill instead. The padding leaves room for the slant.
                    className={`group relative flex min-h-11 w-full items-center overflow-hidden pr-5 pl-4 text-left text-sm font-semibold transition-[background-color,color] duration-150 ease-out outline-none focus-visible:bg-white/25 ${active ? "bg-white/[0.16] text-white" : "bg-white/[0.06] text-white/60 hover:bg-white/10 hover:text-white/90"}`}
                  >
                    {/* The part's progress runs along the item's bottom edge. */}
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-0 h-0.5 bg-white/70"
                      style={{ width: `${fill * 100}%` }}
                    />
                    <span className="flex size-8 shrink-0 items-center justify-center">
                      <Icon
                        name={demo.icon}
                        className={`size-4 transition-colors duration-150 ${active ? "text-white/80" : "text-white/50"}`}
                        strokeWidth={1.75}
                      />
                    </span>
                    <span
                      aria-hidden="true"
                      className="mr-[calc(--spacing(2.75)-0.5px)] ml-[calc(--spacing(0.75)-0.5px)] h-6 w-px shrink-0 bg-white/15"
                    />
                    <span className="min-w-0 py-1.5 leading-tight">{demo.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        }
      >
        <StillDashboardDemo state={state} scene={scene} />
      </ScreenFrame>
    </div>
  );
}

function sameScene(a: DashboardDemoScene, b: DashboardDemoScene) {
  return (
    a.demo === b.demo &&
    a.drawerOpen === b.drawerOpen &&
    a.draft === b.draft &&
    a.sent === b.sent &&
    a.work === b.work &&
    a.step === b.step &&
    a.consent === b.consent &&
    a.replied === b.replied &&
    a.resultShown === b.resultShown
  );
}
