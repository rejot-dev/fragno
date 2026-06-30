/**
 * Resolves npm packages into a Cloudflare Worker Loader `modules` map so codemode
 * snippets can `import("lodash")` inside a dynamically-loaded Worker.
 *
 * Why this exists: a Cloudflare Worker has NO network module loader. `import()` only
 * resolves against the `modules` map passed to `env.LOADER.get(...)`. So bare imports
 * like `import("lodash")`, `npm:` specifiers, and `import("https://esm.sh/...")` all
 * fail at runtime with `No such module`. This helper runs on the HOST (which can
 * `fetch`), pulls the package + its transitive deps from esm.sh in bundled form, and
 * produces a self-consistent module map keyed so the Worker resolves everything
 * locally.
 *
 * Strategy:
 * - Each requested package is fetched from esm.sh in `?bundle-deps` mode and keyed by
 *   its bare specifier (so `import("lodash")` resolves to `modules["lodash"]`).
 * - We walk the (tiny, because bundled) import graph and rewrite every internal
 *   specifier to a flat, collision-free `/npm/...` key that we also add to the map.
 *   Rewriting means resolution never depends on esm.sh URL semantics or query strings
 *   — every importer references an exact key that exists in the map.
 *
 * Note on parsing: this runs in workerd (the backoffice is a Cloudflare Worker), which
 * forbids runtime WebAssembly compilation, so we cannot use es-module-lexer here. The
 * inputs are forgiving — esm.sh bundle output is machine-generated, and a stray match
 * in user code only costs a wasted fetch — so a regex specifier scanner (with the `d`
 * flag for exact rewrite offsets) is the right, dependency-free tradeoff.
 */

interface SpecifierMatch {
  spec: string;
  /** Offset of the specifier text, excluding quotes. */
  start: number;
  end: number;
}

const SPECIFIER_PATTERNS: RegExp[] = [
  // `import ... from "spec"` and `export ... from "spec"`
  /(?:^|[\n;{}])\s*(?:import|export)\b[^"'(]*?\bfrom\s*["']([^"']+)["']/dg,
  // bare side-effect import: `import "spec"`
  /(?:^|[\n;{}])\s*import\s*["']([^"']+)["']/dg,
  // dynamic import with a string literal: `import("spec")`
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/dg,
];

/** Find every literal module specifier and its exact text offsets in `source`. */
function scanSpecifiers(source: string): SpecifierMatch[] {
  const matches: SpecifierMatch[] = [];
  const seen = new Set<number>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(pattern)) {
      const span = m.indices?.[1];
      if (!span) {
        continue;
      }
      const [start, end] = span;
      if (seen.has(start)) {
        continue; // a later pattern already matched this specifier
      }
      seen.add(start);
      matches.push({ spec: m[1], start, end });
    }
  }
  return matches;
}
export interface ResolveNpmOptions {
  /** CDN origin. Defaults to `https://esm.sh`. */
  cdn?: string;
  /** Bare package name -> pinned specifier, e.g. `{ lodash: "lodash@4.17.21" }`. */
  pins?: Record<string, string>;
  /** esm.sh build target. Defaults to `es2022`. */
  target?: string;
  /** Injectable fetch (for tests / custom caching). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Safety bound on graph size. Defaults to 200 modules. */
  maxModules?: number;
}

interface QueueItem {
  url: string;
  key: string;
}

/** Strip a leading `npm:` prefix (a Deno/LLM idiom esm.sh does not understand). */
function stripNpmPrefix(spec: string): string {
  return spec.startsWith("npm:") ? spec.slice("npm:".length) : spec;
}

function isBareSpecifier(spec: string): boolean {
  const s = stripNpmPrefix(spec);
  return !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("/") && !s.startsWith(".");
}

/**
 * Derive a flat, sibling-style module key from a CDN URL pathname. Worker Loader keys
 * are a flat namespace of file-like names (matching the existing `executor.js` /
 * `remote-workflow.js` convention): no leading slash, no nested directories, and the
 * name must end in `.js`. Modules reference each other as `./<key>`.
 */
function flatKeyForUrl(absUrl: string): string {
  const path = new URL(absUrl).pathname.replace(/^\/+/, "");
  const safe = path.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `npm_${safe}`;
  return key.endsWith(".js") ? key : `${key}.js`;
}

/** A module key referenced from another module: a relative sibling import. */
function asImportSpecifier(key: string): string {
  return `./${key}`;
}

/** Apply a pin to the package-name portion of a specifier, keeping any subpath. */
function pinSpecifier(spec: string, pins: Record<string, string>): string {
  const match = spec.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  if (!match) {
    return spec;
  }
  const name = match[1];
  const subpath = match[2] ?? "";
  return `${pins[name] ?? name}${subpath}`;
}

function applyEdits(
  source: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  edits.sort((a, b) => b.start - a.start); // right-to-left so offsets stay valid
  let out = source;
  for (const { start, end, text } of edits) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}

export interface ResolvedNpmModules {
  /** Worker Loader `modules` map: module key -> source. Pass to `env.LOADER.get`. */
  modules: Record<string, string>;
  /** Requested specifier -> module key, e.g. `{ "lodash": "/npm/lodash_4.17.21.js" }`. */
  imports: Record<string, string>;
}

export async function resolveNpmModules(
  specifiers: string[],
  options: ResolveNpmOptions = {},
): Promise<ResolvedNpmModules> {
  const cdn = (options.cdn ?? "https://esm.sh").replace(/\/+$/, "");
  const target = options.target ?? "es2022";
  const doFetch = options.fetchImpl ?? fetch;
  const maxModules = options.maxModules ?? 200;
  const pins = options.pins ?? {};

  const modules: Record<string, string> = {};
  const urlToKey = new Map<string, string>(); // absolute url -> assigned key
  const usedKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const queue: QueueItem[] = [];

  const bundleUrl = (spec: string): string =>
    `${cdn}/${encodeURI(pinSpecifier(stripNpmPrefix(spec), pins))}?bundle-deps&target=${target}`;

  /** Assign a stable, unique, `.js`-suffixed module key to a URL. */
  const assignKey = (absUrl: string): string => {
    const existing = urlToKey.get(absUrl);
    if (existing) {
      return existing;
    }
    let key = flatKeyForUrl(absUrl);
    if (usedKeys.has(key)) {
      const base = key.slice(0, -".js".length);
      let i = 1;
      while (usedKeys.has(`${base}_${i}.js`)) {
        i++;
      }
      key = `${base}_${i}.js`;
    }
    usedKeys.add(key);
    urlToKey.set(absUrl, key);
    return key;
  };

  const enqueue = (absUrl: string, key: string): void => {
    if (seenUrls.has(absUrl)) {
      return;
    }
    seenUrls.add(absUrl);
    queue.push({ url: absUrl, key });
  };

  // Seed: each requested specifier -> its bundle URL. We record the specifier -> key
  // alias so callers can rewrite the snippet's `import("lodash")` to the module key
  // (Worker Loader rejects bare, extension-less module names).
  const imports: Record<string, string> = {};
  for (const spec of specifiers) {
    const url = bundleUrl(spec);
    const key = assignKey(url);
    imports[spec] = key;
    enqueue(url, key);
  }

  while (queue.length > 0) {
    const { url, key } = queue.shift()!;
    if (modules[key] !== undefined) {
      continue;
    }
    if (Object.keys(modules).length >= maxModules) {
      throw new Error(
        `resolveNpmModules: exceeded maxModules (${maxModules}) while resolving ${specifiers.join(", ")}`,
      );
    }

    const res = await doFetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`esm.sh returned ${res.status} ${res.statusText} for ${url}`);
    }
    const finalUrl = res.url || url; // after redirects, for relative resolution
    const src = await res.text();

    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const { spec, start, end } of scanSpecifiers(src)) {
      // esm.sh bundle output uses absolute (`/...`) and occasionally bare specifiers.
      const childUrl = isBareSpecifier(spec) ? bundleUrl(spec) : new URL(spec, finalUrl).toString();
      const childKey = assignKey(childUrl);
      enqueue(childUrl, childKey);
      edits.push({ start, end, text: asImportSpecifier(childKey) });
    }

    modules[key] = applyEdits(src, edits);
  }

  return { modules, imports };
}

/**
 * Rewrite the literal import specifiers in a codemode snippet to the module keys
 * produced by {@link resolveNpmModules}, so `import("lodash")` becomes
 * `import("/npm/lodash_4.17.21.js")` — the form Worker Loader can resolve.
 */
export function rewriteCodeImports(code: string, imports: Record<string, string>): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const { spec, start, end } of scanSpecifiers(code)) {
    const key = imports[spec];
    if (key !== undefined) {
      edits.push({ start, end, text: asImportSpecifier(key) });
    }
  }
  return applyEdits(code, edits);
}

/**
 * Collect the literal bare module specifiers a codemode snippet imports, both static
 * (`import x from "lodash"`) and dynamic with a string literal (`import("lodash/fp")`).
 * Subpaths are kept (esm.sh can bundle them) so the returned strings can be passed
 * straight to {@link resolveNpmModules} and matched by {@link rewriteCodeImports}.
 */
export function collectBareSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const { spec } of scanSpecifiers(code)) {
    if (isBareSpecifier(spec)) {
      found.add(spec);
    }
  }
  return [...found];
}
