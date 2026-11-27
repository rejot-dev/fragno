import { useLayoutEffect } from "react";
import { Outlet } from "react-router";

/**
 * Keeps Leyway's public pages light. The app shell puts the person's theme on the document, and it
 * stays there when they navigate here from the app, so these pages take it off before they paint.
 * The shell applies the stored theme again when it mounts, so there is nothing to restore on leaving.
 */
export default function LightThemeLayout() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  }, []);
  return <Outlet />;
}
