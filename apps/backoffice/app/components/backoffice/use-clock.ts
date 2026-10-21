import { useEffect, useState } from "react";

/** The wall clock, ticking every `tickMs`, so relative times and time windows move with it. */
export function useClock(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [tickMs]);
  return now;
}
