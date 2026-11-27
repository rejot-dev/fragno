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
    <div ref={containerRef} data-ignores-reduced-motion className="group/preview">
      <ScreenFrame
        label="The Leyway dashboard, in one story: someone asks the agent to connect Google Drive and Slack, then for a page of this week's signups, then to tell #sales on Slack about every Business signup."
        // One timeline for the one story, in a segment per part.
        bar={
          <div className="px-5 py-3">
            <ol className="flex gap-5">
              {DASHBOARD_DEMOS.map((demo, index) => {
                const fill =
                  index < timeline.index ? 1 : index === timeline.index ? timeline.progress : 0;
                const active = index === timeline.index;
                return (
                  // Every chapter keeps its size as the story plays, so the one under a finger stays
                  // the one it taps.
                  <li key={demo.id} className="min-w-0 flex-1">
                    <button
                      type="button"
                      aria-current={active ? "step" : undefined}
                      onClick={() => {
                        playheadRef.current = { index, elapsed: 0 };
                        show(index, 0);
                      }}
                      // A chapter of the story, like a video player's: its progress on a track above
                      // its number and title. The part playing is the brightest; parts played stay
                      // filled, dimmer, so the track reads as the story so far.
                      className={`group font-heading flex w-full flex-col gap-2.5 rounded-sm text-left text-[15px] font-normal tracking-[-0.01em] transition-colors duration-150 ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--bo-fg)/40 ${active ? "text-(--bo-fg)" : "text-(--bo-muted) hover:text-(--bo-fg)"}`}
                    >
                      <span
                        aria-hidden="true"
                        className="h-0.5 w-full overflow-hidden rounded-full bg-(--bo-fg)/10"
                      >
                        <span
                          className={`block h-full rounded-full ${active ? "bg-(--bo-fg)" : "bg-(--bo-fg)/30"}`}
                          style={{ width: `${fill * 100}%` }}
                        />
                      </span>
                      <span className="flex min-w-0 items-center gap-2.5 leading-5">
                        <Icon
                          name={demo.icon}
                          className={`size-4 shrink-0 transition-colors duration-150 ${active ? "text-(--bo-fg)/80" : "text-(--bo-muted) group-hover:text-(--bo-fg)/80"}`}
                          strokeWidth={1.75}
                        />
                        {/* Truncating clips to the line box, which is tighter than Outfit's ascenders and
                          descenders; the padding gives them room without moving the line. */}
                        {/* On phones only icons fit; the playing chapter's title shows below. */}
                        <span className="-my-1 truncate py-1 max-sm:sr-only">{demo.title}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p
              aria-hidden="true"
              className="font-heading mt-2 truncate text-[15px] leading-5 tracking-[-0.01em] text-(--bo-fg) sm:hidden"
            >
              {DASHBOARD_DEMOS[timeline.index]?.title}
            </p>
          </div>
        }
      >
        {/* The screen alone, not the timeline below it, shows in a light black and white, its darks
            lifted toward gray, so the hero photo and the brand carry the page's color; it fades into
            the app's real colors while the pointer is over the preview. */}
        <div className="brightness-[1.08] contrast-[0.8] grayscale transition-[filter] duration-500 ease-out group-hover/preview:brightness-100 group-hover/preview:contrast-100 group-hover/preview:grayscale-0">
          <StillDashboardDemo state={state} scene={scene} />
        </div>
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
