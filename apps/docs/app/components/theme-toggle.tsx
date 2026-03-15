import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type ThemeChoice = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const THEME_KEY = "theme";

function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice === "dark" ? "dark" : "light";
}

function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  if (typeof document === "undefined") {
    return resolved;
  }

  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // ignore
  }

  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: THEME_KEY,
        newValue: choice,
      }),
    );
  } catch {
    // ignore
  }

  return resolved;
}

export function ThemeToggle({ className }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  const setTheme = useCallback((choice: ThemeChoice) => {
    setResolvedTheme(applyTheme(choice));
  }, []);

  useEffect(() => {
    setMounted(true);
    if (typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem(THEME_KEY);
    const choice: ThemeChoice =
      stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    setTheme(choice);
  }, [setTheme]);

  if (!mounted) {
    return null;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label="Toggle theme"
      className={cn(
        "border-border/50 bg-background/95 text-foreground inline-flex items-center gap-1 rounded-full border p-1 shadow-sm backdrop-blur-md",
        className,
      )}
    >
      <Sun className={cn("size-4", isDark ? "text-muted-foreground" : "text-foreground")} />
      <Moon className={cn("size-4", isDark ? "text-foreground" : "text-muted-foreground")} />
    </button>
  );
}
