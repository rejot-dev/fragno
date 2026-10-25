import { Outlet, useOutletContext } from "react-router";

import type { ClientOutletContext } from "../clients/layout";
import type { Route } from "./+types/layout";
import { booksPath } from "./books";
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

/**
 * One administration's books: its journal, accounts, reports, parties, and settings. The client's
 * sidebar lists them; each page heads itself.
 */
export default function BooksLayout({ loaderData }: Route.ComponentProps) {
  const client = useOutletContext<ClientOutletContext>();
  const { administration, books, canSetUp } = loaderData;
  const base = booksPath({ slug: client.client.slug, administration: administration.slug });
  return (
    <div className="space-y-6">
      <Outlet context={{ ...client, books, canSetUp, base } satisfies BooksOutletContext} />
    </div>
  );
}
