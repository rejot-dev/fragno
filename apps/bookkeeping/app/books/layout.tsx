import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { Outlet, useLocation, useOutletContext } from "react-router";

import type { ClientOutletContext } from "../clients/layout";
import type { Route } from "./+types/layout";
import { requireBooks } from "./books.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.books.name ?? "Administration"} · Bookkeeping` }];
}

/** Everyone in the client's workspace opens its administrations' books. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { administration, canSetUp, books } = await requireBooks(request, params);
  return { administration, canSetUp, books: await books.describe() };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

type Books = Route.ComponentProps["loaderData"]["books"];

/** What every page of an administration's books receives from the layout. */
export type BooksOutletContext = ClientOutletContext & {
  books: Books;
  /** Whether the person sets the books up: owners and admins of the client. */
  canSetUp: boolean;
  /** The books' own path, which their pages extend. */
  base: string;
};

const TABS = [
  { id: "journal", label: "Journal", path: "" },
  { id: "accounts", label: "Accounts", path: "/accounts" },
  { id: "trial-balance", label: "Trial balance", path: "/trial-balance" },
  { id: "parties", label: "Customers & suppliers", path: "/parties" },
  { id: "settings", label: "Settings", path: "/settings" },
] as const;

/** One administration's books: its journal, accounts, reports, parties, and settings. */
export default function BooksLayout({ loaderData }: Route.ComponentProps) {
  const client = useOutletContext<ClientOutletContext>();
  const { pathname } = useLocation();
  const { administration, books, canSetUp } = loaderData;
  const base = `/w/${client.client.slug}/a/${administration.slug}`;
  // The journal's own pages, such as a new entry, sit under the books' path, not a tab's.
  const current =
    TABS.find((tab) => tab.path !== "" && pathname.startsWith(`${base}${tab.path}`)) ?? TABS[0];
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title={books.name}
        description={`Books kept in ${books.functionalCurrency}.`}
        breadcrumbs={[
          { label: client.client.name, to: `/w/${client.client.slug}` },
          { label: books.name },
        ]}
        code="BKS"
      />
      <OverflowTabRow
        ariaLabel="Books"
        variant="underline"
        trailing={null}
        items={TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          to: `${base}${tab.path}`,
          active: tab.id === current.id,
        }))}
      />
      <Outlet context={{ ...client, books, canSetUp, base } satisfies BooksOutletContext} />
    </div>
  );
}
