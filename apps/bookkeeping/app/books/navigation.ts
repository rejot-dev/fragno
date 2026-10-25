import type { NavigationItem } from "@fragno-private/design-system/navigation-item";

/** An administration's books as sidebar destinations under `base`, the books' own path. */
export function booksNavigation(base: string, pathname: string): NavigationItem[] {
  const at = (path: string) =>
    pathname === `${base}${path}` || pathname.startsWith(`${base}${path}/`);
  return [
    {
      label: "Journal",
      to: base,
      icon: "book-open",
      // Entries are the journal's pages.
      active: pathname === base || at("/entries"),
    },
    { label: "Accounts", to: `${base}/accounts`, icon: "list", active: at("/accounts") },
    {
      label: "Trial balance",
      to: `${base}/trial-balance`,
      icon: "bar-chart-2",
      active: at("/trial-balance"),
    },
    {
      label: "Customers & suppliers",
      to: `${base}/parties`,
      icon: "user-check",
      active: at("/parties"),
    },
    { label: "Settings", to: `${base}/settings`, icon: "settings", active: at("/settings") },
  ];
}
