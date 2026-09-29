import { Menu } from "@base-ui/react/menu";
import { useCallback, useEffect, useState } from "react";

import { Icon, type IconName } from "./icon";
import { SelectorSubmenu } from "./selector-menu";

type ThemeChoice = "light" | "dark" | "system";
type StoredReducedMotionChoice = "reduce" | "no-preference";

const REDUCED_MOTION_STORAGE_KEY = "reduced-motion";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
  { value: "system", label: "System", icon: "monitor" },
] as const;

const THEME_ICONS = {
  light: "sun",
  dark: "moon",
  system: "monitor",
} as const satisfies Record<ThemeChoice, IconName>;

const ITEM_CLASS_NAME =
  "group flex min-h-10 cursor-pointer items-center gap-3 rounded-[4px] px-2.5 text-sm font-medium text-[var(--bo-fg)] outline-none transition-[background-color,box-shadow] duration-150 ease-out data-[highlighted]:bg-[var(--bo-panel-2)]";

const ITEM_ICON_CLASS_NAME =
  "size-4 shrink-0 text-[var(--bo-muted)] transition-colors duration-150 ease-out group-data-[highlighted]:text-[var(--bo-fg)]";

function isThemeChoice(value: unknown): value is ThemeChoice {
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

type AppearancePreferences = {
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

// Selector-menu submenu for choosing the theme and motion preference. Items stay open on click so
// the change is visible while the menu is still showing.
export function AppearanceSubmenu({ preferences }: { preferences: AppearancePreferences }) {
  return (
    <SelectorSubmenu icon={THEME_ICONS[preferences.theme]} label="Appearance">
      <Menu.RadioGroup
        value={preferences.theme}
        aria-label="Theme"
        onValueChange={(value) => {
          if (isThemeChoice(value)) {
            preferences.setTheme(value);
          }
        }}
        className="flex flex-col gap-0.5"
      >
        {THEME_OPTIONS.map(({ value, label, icon }) => (
          <Menu.RadioItem
            key={value}
            value={value}
            closeOnClick={false}
            className={`${ITEM_CLASS_NAME} data-[checked]:bg-[var(--bo-selected-bg)] data-[checked]:shadow-[var(--bo-selected-shadow)]`}
          >
            <Icon name={icon} className={ITEM_ICON_CLASS_NAME} strokeWidth={1.75} />
            <span className="flex-1">{label}</span>
            <Menu.RadioItemIndicator className="text-[var(--bo-accent)]">
              <Icon name="check" className="size-4" />
            </Menu.RadioItemIndicator>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>

      <Menu.Separator className="mx-1 my-1.5 h-px bg-[var(--bo-border)]" />

      <Menu.CheckboxItem
        checked={preferences.reducedMotion}
        onCheckedChange={preferences.setReducedMotion}
        closeOnClick={false}
        className={ITEM_CLASS_NAME}
      >
        <Icon name="eye" className={ITEM_ICON_CLASS_NAME} strokeWidth={1.75} />
        <span className="flex-1">Reduced motion</span>
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-[var(--bo-border)] p-0.5 transition-[background-color] duration-150 ease-out group-data-[checked]:bg-[var(--bo-accent)]"
        >
          <span className="size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-transform duration-150 ease-out group-data-[checked]:translate-x-4" />
        </span>
      </Menu.CheckboxItem>
    </SelectorSubmenu>
  );
}
