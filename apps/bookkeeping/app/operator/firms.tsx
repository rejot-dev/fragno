import { ButtonLink } from "@fragno-private/design-system/button";
import { FormContainer } from "@fragno-private/design-system/form-container";
import { BackofficePageHeader } from "@fragno-private/design-system/page-header";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { env } from "cloudflare:workers";
import { Link } from "react-router";

import { organizationPath } from "../organizations/paths";
import type { Route } from "./+types/firms";
import { requireOperator } from "./operator.server";

export function meta() {
  return [{ title: "Firms · Bookkeeping" }];
}

/**
 * Every firm Bookkeeping created. Operators open the ones they belong to, which are those they
 * created; another operator's firm opens only after its owners invite them.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireOperator(request);
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
    <ButtonLink variant="accent" to="/operator/firms/new">
      New firm
    </ButtonLink>
  );
  return (
    <div className="space-y-6">
      <BackofficePageHeader
        title="Firms"
        description="Accounting firms keep the books of their clients in Bookkeeping."
        breadcrumbs={[{ label: "Operator", to: "/operator" }, { label: "Firms" }]}
        actions={firms.length > 0 ? newFirm : undefined}
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
        <FormContainer title="All firms">
          <ul className="divide-y divide-[var(--bo-border)]">
            {firms.map(({ name, path, member }) => (
              <li key={path} className="flex items-center justify-between gap-3 py-3 text-sm">
                {member ? (
                  <Link to={path} className="font-medium">
                    {name}
                  </Link>
                ) : (
                  <span className="font-medium">{name}</span>
                )}
                {!member && (
                  <span className="text-xs text-[var(--bo-muted)]">You're not a member</span>
                )}
              </li>
            ))}
          </ul>
        </FormContainer>
      )}
    </div>
  );
}
