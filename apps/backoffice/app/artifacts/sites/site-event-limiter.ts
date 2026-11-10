import { SITE_EVENT_LIMITS } from "./site-events";

/** Counts each viewer's events, and says whether one more stays within their limit. */
export type SiteEventLimiter = { limit(key: string): Promise<boolean> };

/** The `SITE_EVENTS` rate limit, which counts across a deployment's Workers. */
export function cloudflareSiteEventLimiter(limiter: RateLimit): SiteEventLimiter {
  return { limit: async (key) => (await limiter.limit({ key })).success };
}

/** Counts in this process, for runtimes without the rate limit, as in Node. */
export function createInMemorySiteEventLimiter(now: () => number): SiteEventLimiter {
  const periodMs = SITE_EVENT_LIMITS.periodSeconds * 1000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit(key) {
      const at = now();
      for (const [counted, window] of windows) {
        if (at - window.start >= periodMs) {
          windows.delete(counted);
        }
      }
      const window = windows.get(key) ?? { start: at, count: 0 };
      window.count += 1;
      windows.set(key, window);
      return window.count <= SITE_EVENT_LIMITS.perViewer;
    },
  };
}
