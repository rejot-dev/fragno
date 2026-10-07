// Node builds do not load a browser analytics SDK, even when serving a production bundle.
export function initializePostHog(): null {
  return null;
}
