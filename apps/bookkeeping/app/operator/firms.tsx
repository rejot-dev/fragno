import { ButtonLink } from "@fragno-private/design-system/button";
import { PageHeading } from "@fragno-private/design-system/page-heading";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";

import { requireOperator } from "../organizations/access.server";
import { organizationPath } from "../organizations/paths";
import { PlaceList } from "../shell/place-list";
import type { Route } from "./+types/firms";

export function meta() {
  return [{ title: "Firms · Bookkeeping" }];
}

/**
 * Every firm Bookkeeping created. Operators open the ones they belong to, which are those they
 * created; another operator's firm opens only after its owners invite them.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const { user } = await requireOperator(request);
  const directory = env.DIRECTORY.getByName("directory");
  const [firms, memberships] = await Promise.all([
    directory.listFirms(),
    directory.listMemberships(user.backofficeUserId),
  ]);
  const joined = new Set(memberships.map(({ organization }) => organization.id));
  return {
    firms: firms.map(({ id, name, kind, slug }) => ({
      name,
      path: organizationPath(kind, slug),
      member: joined.has(id),
    })),
  };
}

export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export default function Firms({ loaderData }: Route.ComponentProps) {
  const { firms } = loaderData;
  const newFirm = (
    <ButtonLink variant="solid" to="/operator/firms/new">
      New firm
    </ButtonLink>
  );
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operator"
        title="Firms"
        meta="Accounting firms keep the books of their clients in Bookkeeping."
        actions={firms.length > 0 ? newFirm : null}
      />
      {firms.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Getting started"
          title="No firms yet"
          description="Create the first firm and invite its owner."
          actions={newFirm}
        />
      ) : (
        <PlaceList title="All firms" icon="briefcase" places={firms} />
      )}
    </div>
  );
}
