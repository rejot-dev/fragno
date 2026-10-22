import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { useOutletContext } from "react-router";

import type { ClientOutletContext } from "../clients/layout";
import { requireOrganization } from "../organizations/access.server";
import type { Route } from "./+types/administration";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.books.name ?? "Administration"} · Bookkeeping` }];
}

/** Everyone in the client's workspace opens its administrations' books. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organization } = await requireOrganization(request, params.slug, "client");
  const administration = await env.DIRECTORY.getByName("directory").findAdministration({
    clientId: organization.id,
    slug: params.administration,
  });
  if (!administration) {
    throw new Response("This administration does not exist.", { status: 404 });
  }
  return {
    administration,
    books: await env.BOOKS.getByName(administration.id).summarize(),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function AdministrationPage({ loaderData }: Route.ComponentProps) {
  const { client } = useOutletContext<ClientOutletContext>();
  const { books } = loaderData;
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title={books.name}
        description={`Books kept in ${books.functionalCurrency}.`}
        breadcrumbs={[{ label: client.name, to: `/w/${client.slug}` }, { label: books.name }]}
      />
      <BackofficeSystemState
        tone="empty"
        label="Journal"
        title="No entries yet"
        description="Your books are open. Entering transactions, invoices, and reports isn't available yet."
      />
    </div>
  );
}
