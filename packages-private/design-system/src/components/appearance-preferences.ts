import { useCallback, useEffect, useState } from "react";

import type { IconName } from "./icon";

type ThemeChoice = "light" | "dark" | "system";
type StoredReducedMotionChoice = "reduce" | "no-preference";

const REDUCED_MOTION_STORAGE_KEY = "reduced-motion";

const THEME_ICONS = {
  light: "sun",
  dark: "moon",
  system: "monitor",
} as const satisfies Record<ThemeChoice, IconName>;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function isStoredReducedMotionChoice(value: unknown): value is StoredReducedMotionChoice {
  return value === "reduce" || value === "no-preference";
}

function applyReducedMotion(enabled: boolean) {
  document.documentElement.dataset.reducedMotion = enabled ? "reduce" : "no-preference";
}

function applyTheme(choice: ThemeChoice) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = choice === "dark" || (choice === "system" && prefersDark);
  const root = document.documentElement;

  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
}

export type AppearancePreferences = {
  theme: ThemeChoice;
  reducedMotion: boolean;
  setTheme: (theme: ThemeChoice) => void;
  setReducedMotion: (enabled: boolean) => void;
};

// Owns applying the stored appearance to the document, so it must stay mounted for the whole page
// rather than living inside a popup that unmounts when closed.
export function useAppearancePreferences(): AppearancePreferences {
  const [theme, setThemeState] = useState<ThemeChoice>("system");
  const [reducedMotion, setReducedMotionState] = useState(false);
  const [followsSystemMotion, setFollowsSystemMotion] = useState(true);

  const setTheme = useCallback((nextTheme: ThemeChoice) => {
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    try {
      window.localStorage.setItem("theme", nextTheme);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, []);

  const setReducedMotion = useCallback((enabled: boolean) => {
    setReducedMotionState(enabled);
    setFollowsSystemMotion(false);
    applyReducedMotion(enabled);
    try {
      window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, enabled ? "reduce" : "no-preference");
    } catch {
      // Motion persistence is optional when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    let storedTheme: string | null = null;
    let storedReducedMotion: string | null = null;
    try {
      storedTheme = window.localStorage.getItem("theme");
      storedReducedMotion = window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY);
    } catch {
      // Fall back to system appearance preferences when storage is unavailable.
    }

    const initialTheme = isThemeChoice(storedTheme) ? storedTheme : "system";
    const systemReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const initialReducedMotion = isStoredReducedMotionChoice(storedReducedMotion)
      ? storedReducedMotion === "reduce"
      : systemReducedMotion;

    setThemeState(initialTheme);
    setReducedMotionState(initialReducedMotion);
    setFollowsSystemMotion(!isStoredReducedMotionChoice(storedReducedMotion));
    applyTheme(initialTheme);
    applyReducedMotion(initialReducedMotion);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleSystemMotionChange = (event: MediaQueryListEvent) => {
      setReducedMotionState(event.matches);
      applyReducedMotion(event.matches);
    };

    if (followsSystemMotion) {
      mediaQuery.addEventListener("change", handleSystemMotionChange);
    }
    return () => {
      mediaQuery.removeEventListener("change", handleSystemMotionChange);
    };
  }, [followsSystemMotion]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      applyTheme("system");
    };

    if (theme === "system") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
    }
    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  }, [theme]);

  return { theme, reducedMotion, setTheme, setReducedMotion };
}

/** The icon of the chosen theme, for a control that opens these options. */
export function appearanceThemeIcon(preferences: AppearancePreferences): IconName {
  return THEME_ICONS[preferences.theme];
}
