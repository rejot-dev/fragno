/*
 * The chart block — a small, dependency-free categorical chart rendered as SVG.
 * Supports `line` and `bar` variants with one or more series whose values align
 * to the shared `categories` axis. Deliberately minimal: enough to visualise a
 * trend or comparison inside the output stream, not a full charting library.
 */

import { BarChart3, LineChart as LineChartIcon } from "lucide-react";

import type { ChartBlock } from "../output-model";
import { BlockFrame } from "./block-frame";

// Cadence accent palette, cycled per series.
const SERIES_COLORS = [
  "var(--cad-brass)",
  "var(--cad-verdigris)",
  "var(--cad-rose)",
  "var(--cad-muted)",
];

const VIEW_W = 640;
const VIEW_H = 240;
const PAD_L = 40;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export function ChartBlockView({ block }: { block: ChartBlock }) {
  const { categories, series, variant } = block;
  const allValues = series.flatMap((entry) => entry.values);
  const max = niceMax(Math.max(1, ...allValues));
  const count = Math.max(1, categories.length);

  // X position of the center of category `index`.
  const categoryCenter = (index: number) => PAD_L + (PLOT_W / count) * index + PLOT_W / count / 2;
  const yFor = (value: number) => PAD_T + PLOT_H - (value / max) * PLOT_H;

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <BlockFrame
      title={block.title}
      icon={
        variant === "bar" ? (
          <BarChart3 className="h-3 w-3" />
        ) : (
          <LineChartIcon className="h-3 w-3" />
        )
      }
    >
      <div className="rounded-lg border border-[color:var(--cad-line)] bg-[var(--cad-panel-2)] p-3">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="h-auto w-full"
          role="img"
          aria-label={block.title ?? "chart"}
        >
          {/* Horizontal grid lines + y-axis labels. */}
          {gridLines.map((fraction) => {
            const y = PAD_T + PLOT_H - fraction * PLOT_H;
            return (
              <g key={fraction}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={VIEW_W - PAD_R}
                  y2={y}
                  stroke="var(--cad-line)"
                  strokeWidth={1}
                />
                <text
                  x={PAD_L - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-[var(--cad-muted-2)]"
                  fontSize={10}
                >
                  {Math.round(max * fraction)}
                </text>
              </g>
            );
          })}

          {/* Series. */}
          {variant === "line"
            ? series.map((entry, seriesIndex) => {
                const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
                const points = entry.values
                  .map((value, index) => `${categoryCenter(index)},${yFor(value)}`)
                  .join(" ");
                return (
                  <g key={entry.name}>
                    <polyline
                      points={points}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {entry.values.map((value, index) => (
                      <circle
                        key={index}
                        cx={categoryCenter(index)}
                        cy={yFor(value)}
                        r={2.5}
                        fill={color}
                      />
                    ))}
                  </g>
                );
              })
            : categories.map((_, categoryIndex) => {
                const slot = PLOT_W / count;
                const barCount = Math.max(1, series.length);
                const barWidth = (slot * 0.7) / barCount;
                const groupStart = PAD_L + slot * categoryIndex + slot * 0.15;
                return (
                  <g key={categoryIndex}>
                    {series.map((entry, seriesIndex) => {
                      const value = entry.values[categoryIndex] ?? 0;
                      const x = groupStart + barWidth * seriesIndex;
                      const y = yFor(value);
                      return (
                        <rect
                          key={entry.name}
                          x={x}
                          y={y}
                          width={Math.max(1, barWidth - 1)}
                          height={Math.max(0, PAD_T + PLOT_H - y)}
                          rx={1.5}
                          fill={SERIES_COLORS[seriesIndex % SERIES_COLORS.length]}
                        />
                      );
                    })}
                  </g>
                );
              })}

          {/* X-axis category labels. */}
          {categories.map((category, index) => (
            <text
              key={index}
              x={categoryCenter(index)}
              y={VIEW_H - PAD_B + 16}
              textAnchor="middle"
              className="fill-[var(--cad-muted)]"
              fontSize={10}
            >
              {category}
            </text>
          ))}
        </svg>

        {/* Legend (only when more than one series). */}
        {series.length > 1 ? (
          <div className="mt-2 flex flex-wrap gap-3">
            {series.map((entry, index) => (
              <span
                key={entry.name}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--cad-muted)]"
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
                />
                {entry.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </BlockFrame>
  );
}
