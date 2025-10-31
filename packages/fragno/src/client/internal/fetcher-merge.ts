import type { FetcherConfig } from "../../api/fragment-instantiation";

/**
 * Merge two fetcher configurations, with user config taking precedence.
 * If user provides a custom function, it takes full precedence.
 * Otherwise, deep merge RequestInit options.
 */
export function mergeFetcherConfigs(
  authorConfig?: FetcherConfig,
  userConfig?: FetcherConfig,
): FetcherConfig | undefined {
  // If user provides custom function, it takes full precedence
  if (userConfig?.type === "function") {
    return userConfig;
  }

  if (!userConfig && authorConfig?.type === "function") {
    return authorConfig;
  }

  // Deep merge RequestInit options
  const authorOpts = authorConfig?.type === "options" ? authorConfig.options : {};
  const userOpts = userConfig?.type === "options" ? userConfig.options : {};

  // If both are empty, return undefined
  if (Object.keys(authorOpts).length === 0 && Object.keys(userOpts).length === 0) {
    return undefined;
  }

  return {
    type: "options",
    options: {
      ...authorOpts,
      ...userOpts,
      headers: mergeHeaders(authorOpts.headers, userOpts.headers),
    },
  };
}

/**
 * Merge headers from author and user configs.
 * User headers override author headers.
 */
function mergeHeaders(author?: HeadersInit, user?: HeadersInit): HeadersInit | undefined {
  if (!author && !user) {
    return undefined;
  }

  // Convert to Headers objects and merge
  const merged = new Headers(author);
  new Headers(user).forEach((value, key) => merged.set(key, value));

  // If no headers after merge, return undefined
  if (merged.keys().next().done) {
    return undefined;
  }

  return merged;
}
