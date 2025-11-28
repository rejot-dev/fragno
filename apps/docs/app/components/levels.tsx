"use client";

import type { ReactNode } from "react";
import { Children, isValidElement, useState } from "react";
import { useLevelContext } from "./levels-context";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

type LevelProps = {
  n: number;
  children: ReactNode;
};

export function Level({ children }: LevelProps) {
  // This component is only used inside Levels, so it just returns its children
  // The filtering logic is in the Levels component
  return <>{children}</>;
}

Level.displayName = "Level";

type LevelsProps = {
  children: ReactNode;
};

export function Levels({ children }: LevelsProps) {
  const { currentLevel: globalLevel } = useLevelContext();
  const [localLevelOverride, setLocalLevelOverride] = useState<number | null>(null);

  // Use local override if set, otherwise use global level
  const currentLevel = localLevelOverride ?? globalLevel;

  // Extract all Level components and their n values
  const levels: { n: number; content: ReactNode }[] = [];

  Children.forEach(children, (child) => {
    if (isValidElement<LevelProps>(child)) {
      // Check if this is a Level component by checking props.n existence
      if (typeof child.props.n === "number") {
        const n = child.props.n;
        levels.push({ n, content: child.props.children });
      }
    }
  });

  // Sort levels by n value
  levels.sort((a, b) => a.n - b.n);

  if (levels.length === 0) {
    console.warn("Levels component found no Level children");
    return null;
  }

  const minLevel = levels[0].n;
  const maxLevel = levels[levels.length - 1].n;

  // Find the closest level to currentLevel
  // Prefer exact match, then closest lower, then closest higher
  let selectedLevel = levels[0];

  for (const level of levels) {
    if (level.n === currentLevel) {
      selectedLevel = level;
      break;
    }
    if (level.n < currentLevel) {
      selectedLevel = level;
    }
  }

  // If no lower level found and we have higher levels, use the first one
  if (selectedLevel.n > currentLevel) {
    selectedLevel = levels[0];
  }

  const canIncreaseDetail = selectedLevel.n > minLevel;
  const canDecreaseDetail = selectedLevel.n < maxLevel;

  const handleIncreaseDetail = () => {
    // Find the next lower level number
    const lowerLevels = levels.filter((l) => l.n < selectedLevel.n);
    if (lowerLevels.length > 0) {
      const nextLevel = lowerLevels[lowerLevels.length - 1].n;
      setLocalLevelOverride(nextLevel);
    }
  };

  const handleDecreaseDetail = () => {
    // Find the next higher level number
    const higherLevels = levels.filter((l) => l.n > selectedLevel.n);
    if (higherLevels.length > 0) {
      const nextLevel = higherLevels[0].n;
      setLocalLevelOverride(nextLevel);
    }
  };

  const handleReset = () => {
    setLocalLevelOverride(null);
  };

  return (
    <div className="group/levels relative my-4">
      {/* Level controls - shown on hover */}
      <div className="absolute -left-12 top-0 flex flex-col gap-1 opacity-0 transition-opacity group-hover/levels:opacity-100">
        <button
          type="button"
          onClick={handleIncreaseDetail}
          disabled={!canIncreaseDetail}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded border bg-white text-xs shadow-sm transition-colors dark:bg-gray-800",
            canIncreaseDetail
              ? "border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-700"
              : "cursor-not-allowed border-gray-200 text-gray-400 dark:border-gray-700 dark:text-gray-600",
          )}
          title="More detail"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleDecreaseDetail}
          disabled={!canDecreaseDetail}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded border bg-white text-xs shadow-sm transition-colors dark:bg-gray-800",
            canDecreaseDetail
              ? "border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-700"
              : "cursor-not-allowed border-gray-200 text-gray-400 dark:border-gray-700 dark:text-gray-600",
          )}
          title="Less detail"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        {localLevelOverride !== null && (
          <button
            type="button"
            onClick={handleReset}
            className="mt-1 flex h-6 w-6 items-center justify-center rounded border border-gray-300 bg-white text-[10px] shadow-sm transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:border-gray-500 dark:hover:bg-gray-700"
            title="Reset to global level"
          >
            ↺
          </button>
        )}
      </div>

      {/* Content */}
      <div>{selectedLevel.content}</div>
    </div>
  );
}

Levels.displayName = "Levels";
