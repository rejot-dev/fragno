// Node builds do not load a browser analytics SDK, even when serving a production bundle.
export async function loadPostHog(): Promise<null> {
  return null;
}
