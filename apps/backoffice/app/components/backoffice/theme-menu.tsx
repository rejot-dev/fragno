import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { Accessibility, Check, Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type ThemeChoice = "light" | "dark" | "system";
type StoredReducedMotionChoice = "reduce" | "no-preference";

const REDUCED_MOTION_STORAGE_KEY = "reduced-motion";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

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

export function BackofficeThemeMenu() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [reducedMotionEnabled, setReducedMotionEnabled] = useState(false);
  const [followsSystemMotion, setFollowsSystemMotion] = useState(true);
  const [isReady, setIsReady] = useState(false);

  const updateTheme = useCallback((nextChoice: ThemeChoice) => {
    setChoice(nextChoice);
    if (typeof window === "undefined") {
      return;
    }

    applyTheme(nextChoice);
    try {
      window.localStorage.setItem("theme", nextChoice);
    } catch {
      // Theme persistence is optional when storage is unavailable.
    }
  }, []);

  const updateReducedMotion = useCallback((enabled: boolean) => {
    setReducedMotionEnabled(enabled);
    setFollowsSystemMotion(false);
    if (typeof window === "undefined") {
      return;
    }

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

    const initialChoice = isThemeChoice(storedTheme) ? storedTheme : "system";
    const systemReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const initialReducedMotion = isStoredReducedMotionChoice(storedReducedMotion)
      ? storedReducedMotion === "reduce"
      : systemReducedMotion;

    setChoice(initialChoice);
    setReducedMotionEnabled(initialReducedMotion);
    setFollowsSystemMotion(!isStoredReducedMotionChoice(storedReducedMotion));
    applyTheme(initialChoice);
    applyReducedMotion(initialReducedMotion);

    const frame = window.requestAnimationFrame(() => {
      setIsReady(true);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleSystemMotionChange = (event: MediaQueryListEvent) => {
      setReducedMotionEnabled(event.matches);
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

    if (choice === "system") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
    }
    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  }, [choice]);

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        disabled={!isReady}
        aria-label={`Theme: ${choice}`}
        title="Choose theme"
        className="group flex h-full w-14 shrink-0 cursor-pointer items-center justify-center border-l border-[color:var(--bo-border)] text-[var(--bo-muted)] transition-[background-color,color] duration-150 ease-out outline-none hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/30 focus-visible:ring-inset disabled:cursor-default disabled:opacity-60 data-[popup-open]:bg-[var(--bo-accent-bg)] data-[popup-open]:text-[var(--bo-accent-fg)]"
      >
        <span className="relative size-4" aria-hidden="true">
          {THEME_OPTIONS.map(({ value, icon: Icon }) => (
            <Icon
              key={value}
              className={cn(
                "absolute inset-0 size-4",
                isReady &&
                  "transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                choice === value
                  ? "scale-100 opacity-100 blur-0"
                  : "scale-[0.25] opacity-0 blur-[4px]",
              )}
            />
          ))}
        </span>
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={0} className="z-50">
          <Menu.Popup
            data-backoffice-root
            className="bo-popover-surface w-60 origin-top-left bg-[var(--bo-panel)] p-2 text-[var(--bo-fg)] transition-[opacity,transform] duration-150 ease-out outline-none data-[ending-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:-translate-y-1 data-[starting-style]:opacity-0"
          >
            <Menu.RadioGroup
              value={choice}
              aria-label="Appearance"
              onValueChange={(value) => {
                if (isThemeChoice(value)) {
                  updateTheme(value);
                }
              }}
              className="space-y-1"
            >
              <p
                aria-hidden="true"
                className="px-2 py-1 text-[9px] font-semibold tracking-[0.24em] text-[var(--bo-muted-2)] uppercase"
              >
                Appearance
              </p>
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <Menu.RadioItem
                  key={value}
                  value={value}
                  className="flex min-h-10 cursor-default items-center gap-3 px-2.5 text-sm text-[var(--bo-muted)] transition-[scale,background-color,color] duration-150 ease-out outline-none active:scale-[0.96] data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)]"
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  <Menu.RadioItemIndicator className="text-[var(--bo-accent-fg)]">
                    <Check className="size-4" aria-hidden="true" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>

            <Menu.Separator className="my-2 h-px bg-[var(--bo-border)]" />
            <label className="flex min-h-12 items-center gap-3 px-2.5 text-sm text-[var(--bo-muted)] transition-[background-color,color] duration-150 ease-out hover:bg-[var(--bo-panel-2)] hover:text-[var(--bo-fg)]">
              <Accessibility className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block">Reduced motion</span>
              </span>
              <Switch.Root
                checked={reducedMotionEnabled}
                onCheckedChange={updateReducedMotion}
                aria-label="Reduced motion"
                className="group inline-flex h-6 w-10 shrink-0 items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-1 transition-[background-color,border-color] duration-150 data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-accent-bg)]"
              >
                <Switch.Thumb className="size-4 bg-[var(--bo-fg)] transition-transform duration-150 group-data-[checked]:translate-x-4" />
              </Switch.Root>
            </label>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
