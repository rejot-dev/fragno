import { useEffect, useRef, useState } from "react";

import { cn } from "../cn";
import { Icon } from "./icon";
import {
  formatWorkflowDuration,
  positionOnScale,
  replayTimeAfter,
  timeAtScalePosition,
  type WorkflowReplaySpeed,
  type WorkflowTimeScale,
} from "./workflow-run-timeline-model";

export type TimelineReplay = {
  playing: boolean;
  speed: WorkflowReplaySpeed;
  play: () => void;
  pause: () => void;
  seek: (at: number) => void;
  /** Steps through 2×, 3×, and 1×, without interrupting playback. */
  changeSpeed: () => void;
};

// Cycles through every speed, so any starting speed comes back around.
const NEXT_SPEED: Record<WorkflowReplaySpeed, WorkflowReplaySpeed> = { 2: 3, 3: 1, 1: 2 };

/** `from` is the time playback resumed at. */
type Playback = { scale: WorkflowTimeScale; from: number; speed: WorkflowReplaySpeed };

/**
 * Plays a replay cursor across `scale`. The cursor is owned by the caller, so views that draw the
 * same moments can follow one playhead; `null` follows the recorded state live.
 */
export function useTimelineReplay({
  scale,
  cursor,
  onCursorChange,
  initialSpeed,
}: {
  scale: WorkflowTimeScale;
  cursor: number | null;
  onCursorChange: (cursor: number | null) => void;
  initialSpeed: WorkflowReplaySpeed;
}): TimelineReplay {
  // Captures the scale at play time, so a live run's moving end does not restart playback.
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [speed, setSpeed] = useState(initialSpeed);
  const onCursorChangeRef = useRef(onCursorChange);
  useEffect(() => {
    onCursorChangeRef.current = onCursorChange;
  });

  useEffect(() => {
    if (playback === null) {
      return undefined;
    }
    const wallStart = performance.now();
    let frame = requestAnimationFrame(function advance(timestamp) {
      const at = replayTimeAfter(
        playback.scale,
        playback.from,
        timestamp - wallStart,
        playback.speed,
      );
      if (at === null) {
        onCursorChangeRef.current(null);
        setPlayback(null);
        return;
      }
      onCursorChangeRef.current(at);
      frame = requestAnimationFrame(advance);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [playback]);

  return {
    playing: playback !== null,
    speed,
    play() {
      setPlayback({ scale, from: cursor ?? scale.startedAt, speed });
    },
    pause() {
      setPlayback(null);
    },
    seek(at) {
      setPlayback(null);
      // Snapping to the end returns to the live view, which also shows reconciled final states.
      onCursorChange(at >= scale.endedAt ? null : at);
    },
    changeSpeed() {
      const next = NEXT_SPEED[speed];
      setSpeed(next);
      // Playback resumes from where it is, so the playhead does not jump.
      if (playback !== null) {
        setPlayback({ scale: playback.scale, from: cursor ?? playback.from, speed: next });
      }
    },
  };
}

const SLIDER_STEPS = 1000;

/** `horizon` is the moment on show: the cursor while replaying, the latest moment otherwise. */
export function TimelineReplayControls({
  replay,
  scale,
  horizon,
  subject,
}: {
  replay: TimelineReplay;
  scale: WorkflowTimeScale;
  horizon: number;
  /** What is replayed, such as "run" or "trace". */
  subject: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={replay.playing ? "Pause replay" : `Replay ${subject}`}
        title={replay.playing ? "Pause replay" : `Replay ${subject}`}
        onClick={replay.playing ? replay.pause : replay.play}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-[4px] transition-[color,background-color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]",
          replay.playing
            ? "bg-[var(--bo-waiting-bg)] text-[var(--bo-waiting)]"
            : "text-[var(--bo-fg)] hover:bg-[var(--bo-panel-2)]",
        )}
      >
        <Icon name={replay.playing ? "pause" : "play"} className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Replay speed ${replay.speed}×. Change speed`}
        title={`Replays at ${replay.speed}× the recorded speed; idle gaps pass in a moment. Click to change.`}
        onClick={replay.changeSpeed}
        className={cn(
          "relative min-w-7 rounded-[3px] border px-1 text-[10px] leading-4 font-semibold tabular-nums transition-[color,border-color,scale] duration-150 ease-out after:absolute after:-inset-1.5 focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:outline-none active:scale-[0.96]",
          replay.playing
            ? "border-[color:var(--bo-waiting)]/40 text-[var(--bo-waiting)]"
            : "border-[color:var(--bo-border)] text-[var(--bo-muted)] hover:border-[color:var(--bo-muted-2)] hover:text-[var(--bo-fg)]",
        )}
      >
        {replay.speed}×
      </button>
      <label className="flex items-center">
        <span className="sr-only">Replay position</span>
        <input
          type="range"
          aria-valuetext={formatWorkflowDuration(horizon - scale.startedAt, "fine")}
          min={0}
          max={SLIDER_STEPS}
          step="any"
          value={positionOnScale(scale, horizon) * SLIDER_STEPS}
          onChange={(event) => {
            replay.seek(timeAtScalePosition(scale, Number(event.target.value) / SLIDER_STEPS));
          }}
          className="w-28 accent-[color:var(--bo-accent)]"
        />
      </label>
      <span className="min-w-12 text-right text-xs whitespace-nowrap text-[var(--bo-fg)] tabular-nums">
        {formatWorkflowDuration(horizon - scale.startedAt, "fine")}
      </span>
    </div>
  );
}
