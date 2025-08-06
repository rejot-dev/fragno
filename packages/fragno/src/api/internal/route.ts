export function getMountRoute(opts: { mountRoute?: string; name: string }) {
  const mountRoute = opts.mountRoute ?? `/api/${opts.name}`;

  if (mountRoute.endsWith("/")) {
    return mountRoute.slice(0, -1);
  }

  return mountRoute;
}
