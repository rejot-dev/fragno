import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useActionData, useFetcher } from "react-router";

import { PerspectiveProvider } from "./essay-primitives";
import { defaultPerspective } from "./types";
import type {
  HomeActionData,
  PerspectiveActionData,
  PerspectiveAudience,
  PerspectiveState,
  PerspectiveTime,
} from "./types";

function PerspectiveBars({ time, motionKey }: { time: PerspectiveTime; motionKey: number }) {
  const patterns: Record<PerspectiveTime, number[]> = {
    low: [18, 28, 22, 36, 28, 48, 34, 44, 30, 38],
    medium: [24, 42, 34, 58, 46, 74, 38, 62, 82, 48],
    high: [30, 56, 42, 76, 58, 92, 64, 84, 100, 70],
  };
  const barColors = [
    "var(--editorial-primary)",
    "var(--editorial-primary)",
    "var(--editorial-tertiary)",
    "var(--editorial-tertiary)",
    "var(--editorial-secondary)",
    "var(--editorial-secondary)",
    "var(--editorial-primary)",
    "var(--editorial-tertiary)",
    "var(--editorial-secondary)",
    "var(--editorial-primary)",
  ];

  return (
    <div className="flex h-14 items-end justify-center gap-1.5 overflow-hidden" aria-hidden>
      {patterns[time].map((height, index) => (
        <span
          key={`${motionKey}-${time}-${index}`}
          className="block w-1.5 origin-bottom animate-[perspective-bar_420ms_cubic-bezier(0.22,1,0.36,1)]"
          style={{
            height: `${height}%`,
            backgroundColor: barColors[index],
            animationDelay: `${index * 28}ms`,
          }}
        />
      ))}
    </div>
  );
}

export function PerspectiveControls({ children }: { children: ReactNode }) {
  const actionData = useActionData<HomeActionData | undefined>();
  const fetcher = useFetcher<PerspectiveActionData>();
  const navigatedPerspective =
    actionData?.intent === "perspective" ? actionData.perspective : undefined;
  const persistedPerspective =
    fetcher.data?.intent === "perspective" ? fetcher.data.perspective : navigatedPerspective;
  const [localPerspective, setLocalPerspective] = useState<PerspectiveState>(defaultPerspective);
  const [previewAudience, setPreviewAudience] = useState<PerspectiveAudience | null>(null);
  const [previewTime, setPreviewTime] = useState<PerspectiveTime | null>(null);
  const [motionKey, setMotionKey] = useState(0);

  useEffect(() => {
    if (persistedPerspective) {
      setLocalPerspective(persistedPerspective);
    }
  }, [persistedPerspective]);

  const committedPerspective = useMemo(
    () => persistedPerspective ?? localPerspective,
    [localPerspective, persistedPerspective],
  );

  const perspective = useMemo(() => {
    if (fetcher.formData) {
      const audience = fetcher.formData.get("audience");
      const time = fetcher.formData.get("time");
      return {
        audience:
          audience === "authors" || audience === "users" || audience === "both"
            ? audience
            : committedPerspective.audience,
        time:
          time === "low" || time === "medium" || time === "high" ? time : committedPerspective.time,
      } satisfies PerspectiveState;
    }

    return {
      audience: previewAudience ?? committedPerspective.audience,
      time: previewTime ?? committedPerspective.time,
    } satisfies PerspectiveState;
  }, [committedPerspective, fetcher.formData, previewAudience, previewTime]);

  const canResetPerspective =
    committedPerspective.audience !== defaultPerspective.audience ||
    committedPerspective.time !== defaultPerspective.time;

  function updatePerspective(next: PerspectiveState) {
    setPreviewAudience(null);
    setPreviewTime(null);
    setLocalPerspective(next);
    setMotionKey((current) => current + 1);
    fetcher.submit(
      { intent: "perspective", audience: next.audience, time: next.time },
      { method: "post" },
    );
  }

  return (
    <PerspectiveProvider value={{ perspective, committedPerspective, motionKey }}>
      <section className="mb-24 max-w-4xl space-y-10 border-y border-[var(--editorial-ghost-border)] py-10 md:py-12">
        <div className="text-base font-bold tracking-[0.14em] text-[var(--editorial-secondary)] uppercase">
          Set your perspective
        </div>

        <fetcher.Form
          method="post"
          className="grid grid-cols-1 gap-12 md:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)] md:gap-16"
        >
          <input type="hidden" name="intent" value="perspective" />

          <fieldset className="space-y-6 border-none p-0">
            <legend className="mb-8 text-base font-bold tracking-[0.14em] text-(--editorial-ink) uppercase">
              What are you here to learn about?
            </legend>
            {[
              {
                value: "authors",
                label: "Building full-stack libraries",
                accent: "var(--editorial-primary)",
                keycap: "a.",
              },
              {
                value: "users",
                label:
                  "Integrating full-stack libraries so that you can focus on the business logic",
                accent: "var(--editorial-tertiary)",
                keycap: "b.",
              },
              {
                value: "both",
                label: "Full-stack libraries in general. Show me both sides of the story!",
                accent: "var(--editorial-secondary)",
                keycap: "c.",
              },
            ].map((option) => {
              const checked = committedPerspective.audience === option.value;
              const previewing = previewAudience === option.value;
              const highlighted = perspective.audience === option.value;

              return (
                <label
                  key={option.value}
                  className="group flex cursor-pointer items-start gap-4"
                  style={{ color: highlighted ? "var(--editorial-ink)" : "var(--editorial-muted)" }}
                  onMouseEnter={() => {
                    setPreviewAudience(option.value as PerspectiveAudience);
                    setMotionKey((current) => current + 1);
                  }}
                  onMouseLeave={() => {
                    setPreviewAudience(null);
                    setMotionKey((current) => current + 1);
                  }}
                  onFocus={() => setPreviewAudience(option.value as PerspectiveAudience)}
                  onBlur={() => setPreviewAudience(null)}
                >
                  <input
                    type="radio"
                    name="audience"
                    value={option.value}
                    checked={checked}
                    onChange={(event) =>
                      updatePerspective({
                        ...committedPerspective,
                        audience: event.currentTarget.value as PerspectiveAudience,
                      })
                    }
                    className="sr-only"
                  />
                  <span
                    className="mt-1.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all duration-300"
                    style={{
                      borderColor:
                        highlighted || previewing ? option.accent : "var(--editorial-ghost-border)",
                      transform: previewing ? "scale(1.08)" : "scale(1)",
                    }}
                  >
                    <span
                      className="h-2 w-2 rounded-full transition-all duration-300"
                      style={{
                        backgroundColor: option.accent,
                        opacity: checked || previewing ? 1 : 0,
                        transform: checked || previewing ? "scale(1)" : "scale(0.35)",
                      }}
                    />
                  </span>
                  <span className="text-base leading-[1.7] transition-colors duration-300 group-hover:text-[var(--editorial-ink)]">
                    <span className="mr-2 font-bold text-[var(--editorial-ink)]">
                      {option.keycap}
                    </span>
                    {option.label}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <fieldset className="space-y-6 border-none p-0">
            <legend className="mb-8 text-base font-bold tracking-[0.14em] text-[var(--editorial-ink)] uppercase">
              How much time do you have?
            </legend>

            <div className="space-y-6 bg-[color-mix(in_srgb,var(--editorial-surface-low)_82%,transparent)] p-5 shadow-[inset_0_0_0_1px_var(--editorial-ghost-border)]">
              <PerspectiveBars time={perspective.time} motionKey={motionKey} />
              <div className="space-y-4">
                <div className="relative">
                  <input
                    type="range"
                    min="1"
                    max="3"
                    step="1"
                    value={perspective.time === "low" ? 1 : perspective.time === "medium" ? 2 : 3}
                    onChange={(event) => {
                      const time =
                        event.currentTarget.value === "1"
                          ? "low"
                          : event.currentTarget.value === "2"
                            ? "medium"
                            : "high";
                      updatePerspective({ ...committedPerspective, time });
                    }}
                    onInput={(event) => {
                      const time =
                        event.currentTarget.value === "1"
                          ? "low"
                          : event.currentTarget.value === "2"
                            ? "medium"
                            : "high";
                      setPreviewTime(time);
                      setMotionKey((current) => current + 1);
                    }}
                    onMouseLeave={() => setPreviewTime(null)}
                    onPointerUp={() => setPreviewTime(null)}
                    onBlur={() => setPreviewTime(null)}
                    name="timeRange"
                    className="relative z-20 h-6 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--editorial-ink)] [&::-moz-range-track]:h-[2px] [&::-moz-range-track]:bg-[var(--editorial-ghost-border)] [&::-webkit-slider-runnable-track]:h-[2px] [&::-webkit-slider-runnable-track]:bg-[var(--editorial-ghost-border)] [&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--editorial-ink)]"
                    aria-label="Time available"
                  />
                </div>
                <input type="hidden" name="time" value={perspective.time} />
                <div className="flex justify-between text-sm font-bold tracking-[0.14em] text-[var(--editorial-muted)] uppercase">
                  {(
                    [
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                    ] as const
                  ).map((timeOption) => (
                    <button
                      key={timeOption.value}
                      type="button"
                      onClick={() =>
                        updatePerspective({ ...committedPerspective, time: timeOption.value })
                      }
                      className={`cursor-pointer transition-colors hover:text-[var(--editorial-ink)] ${
                        perspective.time === timeOption.value ? "text-[var(--editorial-ink)]" : ""
                      }`}
                    >
                      {timeOption.label}
                    </button>
                  ))}
                </div>
                <noscript>
                  <button
                    type="submit"
                    name="intent"
                    value="perspective"
                    className="mt-3 inline-flex items-center justify-center bg-[var(--editorial-primary)] px-4 py-2 text-sm font-bold tracking-[0.12em] text-[var(--primary-foreground)] uppercase transition-colors"
                  >
                    Apply perspective
                  </button>
                </noscript>
              </div>
            </div>

            <p className="text-base leading-[1.7] text-[var(--editorial-muted)]">
              We&apos;ll keep the lines most relevant to your goal crisp, and let the rest recede
              into the background.
            </p>
          </fieldset>
        </fetcher.Form>

        <style>{`
          @keyframes perspective-bar {
            from { transform: scaleY(0.2); opacity: 0.2; }
            to { transform: scaleY(1); opacity: 1; }
          }
          @keyframes perspective-muted-in {
            from { opacity: 0.62; filter: blur(0.18px) saturate(0.82); }
            to { opacity: 1; filter: blur(0px) saturate(1); }
          }
          @keyframes perspective-muted-out {
            from { opacity: 0.55; filter: blur(0.12px) saturate(0.86); }
            to { opacity: 0.18; filter: blur(0.35px) saturate(0.58); }
          }
        `}</style>

        {canResetPerspective ? (
          <div className="pointer-events-none fixed right-[max(1rem,calc(50%-560px))] bottom-4 z-30 min-[1120px]:bottom-0">
            <button
              type="button"
              onClick={() => updatePerspective(defaultPerspective)}
              className="pointer-events-auto inline-flex items-center rounded-full bg-(--editorial-ink) px-3 py-2 text-[10px] font-bold tracking-widest text-(--editorial-surface) uppercase shadow-[0_10px_30px_rgb(15_23_42/0.25)] transition-opacity hover:opacity-90"
            >
              Reset Perspective
            </button>
          </div>
        ) : null}
        {children}
      </section>
    </PerspectiveProvider>
  );
}
