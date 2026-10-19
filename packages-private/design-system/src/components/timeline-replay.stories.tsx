import { useState } from "react";

import { TimelineReplayControls, useTimelineReplay } from "./timeline-replay";
import {
  formatWorkflowDuration,
  positionOnScale,
  timeScaleOverMoments,
  type WorkflowTimeScale,
} from "./workflow-run-timeline-model";

export default { title: "Data/Timeline replay" };

const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
const s = (seconds: number) => T0 + seconds * 1000;
const DAY_S = 86_400;

/** The controls driving a bare track, so playback, seeking, and speeds can be tried on their own. */
function Frame({ moments }: { moments: readonly number[] }) {
  const scale = timeScaleOverMoments(Math.min(...moments), Math.max(...moments), moments);
  const [cursor, setCursor] = useState<number | null>(null);
  const replay = useTimelineReplay({ scale, cursor, onCursorChange: setCursor });
  const horizon = cursor ?? scale.endedAt;

  return (
    <div className="flex max-w-3xl flex-col gap-4 text-[var(--bo-fg)]">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold">Replay</span>
        <span className="text-xs text-[var(--bo-muted)]">
          {cursor === null ? "Showing the latest state" : "Replaying"}
        </span>
        <span className="ml-auto">
          <TimelineReplayControls
            replay={replay}
            scale={scale}
            horizon={horizon}
            subject="timeline"
          />
        </span>
      </div>
      <Track scale={scale} moments={moments} horizon={horizon} />
    </div>
  );
}

function percent(position: number): string {
  return `${position * 100}%`;
}

function Track({
  scale,
  moments,
  horizon,
}: {
  scale: WorkflowTimeScale;
  moments: readonly number[];
  horizon: number;
}) {
  return (
    <div className="relative h-10 overflow-hidden rounded-[4px] border border-[color:var(--bo-border)] bg-[var(--bo-panel)]">
      {scale.segments.map((segment) =>
        segment.idle ? (
          <span
            key={segment.from}
            title={`${formatWorkflowDuration(segment.to - segment.from, "coarse")} idle`}
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--bo-border)_0_1px,transparent_1px_6px)]"
            style={{ left: percent(segment.position), width: percent(segment.width) }}
          />
        ) : null,
      )}
      <span
        className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--bo-accent)_14%,transparent)]"
        style={{ width: percent(positionOnScale(scale, horizon)) }}
      />
      {moments.map((moment) => (
        <span
          key={moment}
          className={`absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            moment <= horizon ? "bg-[var(--bo-live)]" : "bg-[var(--bo-muted-2)] opacity-50"
          }`}
          style={{ left: percent(positionOnScale(scale, moment)) }}
        />
      ))}
      <span
        className="absolute inset-y-0 w-px bg-[var(--bo-accent)]"
        style={{ left: percent(positionOnScale(scale, horizon)) }}
      />
    </div>
  );
}

export function ShortRun() {
  return <Frame moments={[s(0), s(0.4), s(1.1), s(3.2), s(4)]} />;
}

/** The idle day is squeezed on the scale and crossed in half a second at any speed. */
export function IdleDayCompressed() {
  return <Frame moments={[s(0), s(2), s(5), s(DAY_S + 5), s(DAY_S + 8), s(DAY_S + 12)]} />;
}
