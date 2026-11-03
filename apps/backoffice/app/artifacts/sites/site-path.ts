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
