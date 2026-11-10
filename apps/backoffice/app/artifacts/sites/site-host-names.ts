// Read on every request the Worker receives, so it imports nothing.

/** Paths under it are the site host's own and never reach a site, so no site's path is in it. */
export const SITE_HOST_PATHS = "/__ley/";

/** Where Backoffice posts a viewer's ticket to a site host. */
export const SITE_SIGN_IN_PATH = `${SITE_HOST_PATHS}sign-in`;

/**
 * The origin a scope's sites are served at, such as `https://quiet-amber-falcon.ley.run`. A
 * `*.localhost` domain is served over http, as browsers treat it as secure.
 */
export function siteHostOrigin(host: string, domain: string): string {
  const hostname = domain.split(":")[0];
  const local = hostname === "localhost" || hostname.endsWith(".localhost");
  return `${local ? "http" : "https"}://${host}.${domain}`;
}

/** Where people open a site: its path below `/workspace`, at its host, with a trailing slash. */
export function siteUrl(origin: string, sitePath: string): string {
  const path = sitePath.slice("/workspace".length).split("/").map(encodeURIComponent).join("/");
  return `${origin}${path}/`;
}

/**
 * Where on the site host at `origin` to continue after signing in, as an absolute URL, or null
 * when `next`, a path or URL, leads elsewhere. Browsers drop tabs and newlines from URLs and read
 * `//` as another host, so only the URL `next` resolves to says where it leads.
 */
export function siteHostDestination(origin: string, next: string): string | null {
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? url.href : null;
}

/**
 * A sites domain as URLs spell it, without the default port of the scheme it is served over:
 * `ley.run:443` is `ley.run`, as `url.host` reads it.
 */
export function normalizedSitesDomain(domain: string): string {
  return new URL(siteHostOrigin("host", domain)).host.slice("host.".length);
}

/**
 * The subdomain a request to the sites domain names, or null when it names none, as for the
 * domain itself; undefined when the request is for another domain, such as Backoffice's.
 */
export function siteHostOf(url: URL, domain: string): string | null | undefined {
  const host = url.host.toLowerCase();
  if (host === domain) {
    return null;
  }
  return host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : undefined;
}
