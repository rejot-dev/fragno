import type { RouteConfig, RouteConfigEntry } from "@react-router/dev/routes";

import allRoutes from "./routes.definition";

type DocsBuildTarget = "all" | "docs" | "backoffice";

const BACKOFFICE_PATH_PREFIXES = [
  "/backoffice",
  "/__dev/workers",
  "/api/cloudflare",
  "/api/resend",
  "/api/telegram",
  "/api/otp",
  "/api/github",
  "/api/upload",
  "/api/pi",
  "/api/automations",
  "/api/workflows",
] as const;

function getDocsBuildTarget(value = process.env.FRAGNO_DOCS_TARGET): DocsBuildTarget {
  if (value === undefined) {
    return "all";
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "all" || normalizedValue === "docs" || normalizedValue === "backoffice") {
    return normalizedValue;
  }

  throw new Error(
    `Invalid FRAGNO_DOCS_TARGET value: ${value}. Expected one of: all, docs, backoffice.`,
  );
}

function normalizePathname(pathname: string) {
  const trimmedPathname = pathname.trim();

  if (trimmedPathname.length === 0) {
    return "/";
  }

  const normalizedPathname = trimmedPathname.startsWith("/")
    ? trimmedPathname
    : `/${trimmedPathname}`;

  return normalizedPathname.replace(/\/+/gu, "/");
}

function joinRoutePath(parentPath: string, routePath: string | undefined) {
  if (routePath === undefined) {
    return parentPath;
  }

  return normalizePathname(parentPath === "/" ? routePath : `${parentPath}/${routePath}`);
}

function isBackofficePathname(pathname: string) {
  const normalizedPathname = normalizePathname(pathname);

  return BACKOFFICE_PATH_PREFIXES.some(
    (prefix) => normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`),
  );
}

function isRouteIncluded(target: DocsBuildTarget, pathname: string) {
  if (target === "all") {
    return true;
  }

  const isBackofficeRoute = isBackofficePathname(pathname);
  return target === "backoffice" ? isBackofficeRoute : !isBackofficeRoute;
}

function filterRoutes(
  routes: RouteConfigEntry[],
  target: DocsBuildTarget,
  parentPath = "/",
): RouteConfigEntry[] {
  const filteredRoutes: RouteConfigEntry[] = [];

  for (const route of routes) {
    const routePathname = route.index ? parentPath : joinRoutePath(parentPath, route.path);
    const filteredChildren = route.children
      ? filterRoutes(route.children, target, routePathname)
      : undefined;
    const includeRoute =
      route.path !== undefined || route.index ? isRouteIncluded(target, routePathname) : false;

    if (filteredChildren !== undefined && filteredChildren.length > 0) {
      filteredRoutes.push({ ...route, children: filteredChildren });
      continue;
    }

    if (includeRoute) {
      filteredRoutes.push(route);
    }
  }

  return filteredRoutes;
}

export default filterRoutes(allRoutes, getDocsBuildTarget()) satisfies RouteConfig;
