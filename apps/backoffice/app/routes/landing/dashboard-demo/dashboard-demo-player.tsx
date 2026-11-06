import { memo, useEffect, useRef, useState } from "react";

import { DashboardDemo } from "./dashboard-demo";
import type { DashboardDemoState } from "./dashboard-demo-state";
import {
  DASHBOARD_DEMOS,
  durationOf,
  type DashboardDemoScene,
  sceneAt,
} from "./dashboard-demo-story";
import { LaptopFrame } from "./laptop-frame";

// The timeline below redraws as a story plays; the dashboard redraws only when its scene changes.
const StillDashboardDemo = memo(DashboardDemo);

/**
 * The dashboard demo on its laptop, playing its story's parts one after another on a loop while it
 * is on screen, and pausing where it is when it scrolls away. Below it, the story's timeline, a
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
        playhead.elapsed += time - lastFrameAt;
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
      <LaptopFrame label="The Leyway dashboard, in one story: someone asks the agent to connect Google Drive and Slack, then for a page of this week's signups, then to tell #sales on Slack about every Business signup.">
        <StillDashboardDemo state={state} scene={scene} />
      </LaptopFrame>
      {/* One timeline for the one story, in a segment per part. */}
      <ol className="mx-auto mt-2 flex max-w-2xl justify-center gap-1 px-4">
        {DASHBOARD_DEMOS.map((demo, index) => {
          const fill =
            index < timeline.index ? 1 : index === timeline.index ? timeline.progress : 0;
          const active = index === timeline.index;
          return (
            <li key={demo.id} className="min-w-0 flex-1">
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                onClick={() => {
                  playheadRef.current = { index, elapsed: 0 };
                  show(index, 0);
                }}
                className={`group flex h-full w-full flex-col justify-end gap-2 py-2 pr-2 text-left text-xs font-medium transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 sm:text-sm ${active ? "text-[var(--bo-fg)]" : "text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]"}`}
              >
                <span className="leading-tight">{demo.title}</span>
                <span className="-mr-2 block h-0.5 overflow-hidden bg-[color-mix(in_srgb,var(--bo-fg)_12%,transparent)]">
                  <span
                    className="block h-full bg-[var(--bo-fg)]"
                    style={{ width: `${fill * 100}%` }}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
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
