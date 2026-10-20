import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { useOutletContext } from "react-router";

import { requireWorkspace } from "../workspace/access.server";
import type { WorkspaceOutletContext } from "../workspace/layout";
import type { Route } from "./+types/administration";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.books.name ?? "Administration"} · Bookkeeping` }];
}

/** Everyone in the workspace opens its administrations' books. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { membership } = await requireWorkspace(request, params.slug);
  const administration = await env.WORKSPACES.getByName("workspaces").findAdministration({
    workspaceId: membership.workspace.id,
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
  const { workspace } = useOutletContext<WorkspaceOutletContext>();
  const { books } = loaderData;
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title={books.name}
        description={`Books kept in ${books.functionalCurrency}.`}
        breadcrumbs={[{ label: workspace.name, to: `/w/${workspace.slug}` }, { label: books.name }]}
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
