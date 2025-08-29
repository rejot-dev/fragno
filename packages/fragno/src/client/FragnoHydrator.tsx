import { useMemo } from "react";
import { hydrateFromWindow } from "../util/ssr";

export function FragnoHydrator({ children }: { children: React.ReactNode }) {
  // Ensure initial data is transferred from window before any hooks run
  // Running in useMemo makes this happen during render, ahead of effects
  useMemo(() => {
    hydrateFromWindow();
  }, []);
  return children;
}
