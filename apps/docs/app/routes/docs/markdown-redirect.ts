/**
 * Builds the markdown API URL for a given set of slugs.
 * Uses slugs (URL path segments) rather than file paths to ensure
 * index pages resolve correctly (e.g., ["forms"] -> /api/markdown/forms).
 */
export function buildMarkdownApiUrl(slugs: string[], baseUrl: string): URL {
  return new URL(`/api/markdown/${slugs.join("/")}`, baseUrl);
}
