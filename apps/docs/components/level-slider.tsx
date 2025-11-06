"use client";

import { useLevelContext } from "./levels-context";
import { cn } from "@/lib/cn";

const LEVELS = [
  { value: 1, label: "Detailed" },
  { value: 2, label: "Medium" },
  { value: 3, label: "Summary" },
];

export function LevelSlider() {
  const { currentLevel, setCurrentLevel } = useLevelContext();

  return (
    <div className="relative mb-8 overflow-hidden rounded-2xl border border-black/5 bg-white/70 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-gray-900/40">
      <div className="pointer-events-none absolute right-4 top-4 h-6 w-6 rotate-45 border border-gray-200/60 dark:border-white/10" />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-200">
            Reading Level
          </h3>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {LEVELS.find((l) => l.value === currentLevel)?.label}
          </span>
        </div>

        <div className="space-y-3">
          {/* Slider */}
          <div className="relative">
            <input
              type="range"
              min="1"
              max="3"
              step="1"
              value={currentLevel}
              onChange={(e) => setCurrentLevel(Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 dark:bg-gray-700 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-gray-300 [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:transition-all [&::-moz-range-thumb]:hover:border-gray-400 dark:[&::-moz-range-thumb]:border-gray-600 dark:[&::-moz-range-thumb]:bg-gray-800 dark:[&::-moz-range-thumb]:hover:border-gray-500 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-gray-300 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:border-gray-400 dark:[&::-webkit-slider-thumb]:border-gray-600 dark:[&::-webkit-slider-thumb]:bg-gray-800 dark:[&::-webkit-slider-thumb]:hover:border-gray-500"
            />
          </div>

          {/* Labels */}
          <div className="flex justify-between px-1">
            {LEVELS.map((level) => (
              <button
                key={level.value}
                type="button"
                onClick={() => setCurrentLevel(level.value)}
                className={cn(
                  "text-xs transition-colors",
                  currentLevel === level.value
                    ? "font-semibold text-gray-900 dark:text-white"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300",
                )}
              >
                {level.label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Adjust the slider to see more or less detail in the content below
        </p>
      </div>
    </div>
  );
}
