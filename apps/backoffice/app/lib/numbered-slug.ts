/**
 * The next slug in a base's sequence: the base itself, then `base-2`, `base-3`, …, numbered after
 * the highest one taken, so a deleted slug is handed out again only when it was the highest.
 * `taken` may hold other slugs that merely start with the base, such as `acme-corp` for `acme`, as
 * a prefix query returns them; those do not count.
 */
export function nextNumberedSlug(base: string, taken: readonly string[]): string {
  const highest = taken.reduce((max, slug) => Math.max(max, slugNumber(base, slug)), 0);
  return highest === 0 ? base : `${base}-${highest + 1}`;
}

/** 1 for the base itself, N for `base-N`, else 0. */
function slugNumber(base: string, slug: string): number {
  if (slug === base) {
    return 1;
  }
  const suffix = slug.startsWith(`${base}-`) ? slug.slice(base.length + 1) : "";
  return /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : 0;
}
