import { SITE_HOST_PATHS } from "./site-host-names";

const WORKSPACE = "/workspace/";
const BUILD_DIRECTORY = "/workspace/.build/";
const SITE_SUFFIX = ".site";

/**
 * Why `path` cannot be a site, or null when it can: a `<name>.site` directory in the workspace,
 * outside `.build` and outside other sites, so the first `.site` segment of a URL names the site.
 */
export function sitePathProblem(path: string): string | null {
  if (!path.startsWith(WORKSPACE) || !path.endsWith(SITE_SUFFIX)) {
    return `${path} is not a /workspace/**/<name>.site directory.`;
  }
  if (path.startsWith(BUILD_DIRECTORY)) {
    return `${path} is inside /workspace/.build, which holds builds.`;
  }
  // Builds list a site's files by glob, which would read these as wildcards.
  if (/[*?]/u.test(path)) {
    return `${path} contains * or ?, which a site's path cannot.`;
  }
  const segments = path.slice(WORKSPACE.length).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `${path} is not a normalized path.`;
  }
  // A site is served at its path below /workspace, so the host's own paths cannot hold one.
  if (`/${segments[0]}/` === SITE_HOST_PATHS) {
    return `${path} is inside ${WORKSPACE}${segments[0]}, whose address sites cannot use.`;
  }
  const ancestor = segments.slice(0, -1).findIndex((segment) => segment.endsWith(SITE_SUFFIX));
  if (ancestor !== -1) {
    return `${path} is inside the site ${WORKSPACE}${segments.slice(0, ancestor + 1).join("/")}; sites cannot nest.`;
  }
  return null;
}

export function isSitePath(path: string): boolean {
  return sitePathProblem(path) === null;
}

/**
 * Where a site's builds live: `/workspace/tools/shop.site` builds into
 * `/workspace/.build/tools/shop.site`, one directory per build key beside the pointer to the one
 * it serves.
 */
export function siteBuildDirectory(sitePath: string): string {
  return `${BUILD_DIRECTORY}${sitePath.slice(WORKSPACE.length)}`;
}

/**
 * The site a URL path names and the path within it, as spelled, from the segments after where
 * sites are mounted: `tools/shop.site/api/orders` is `/workspace/tools/shop.site` at
 * `/api/orders`, and the path within is null at the site's root without its trailing slash.
 */
export function siteRequestTarget(
  segments: readonly string[],
): { sitePath: string; pathname: string | null } | null {
  let names: string[];
  try {
    names = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  // Sites cannot nest, so the first `.site` segment ends the site's path.
  const siteEnd = names.findIndex((name) => name.endsWith(SITE_SUFFIX));
  if (siteEnd === -1) {
    return null;
  }
  const sitePath = `${WORKSPACE}${names.slice(0, siteEnd + 1).join("/")}`;
  if (!isSitePath(sitePath)) {
    return null;
  }
  const rest = segments.slice(siteEnd + 1);
  return { sitePath, pathname: rest.length === 0 ? null : `/${rest.join("/")}` };
}
