import { Link, useNavigate, useOutletContext } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

export function meta() {
  return [
    { title: "Backoffice Workflows" },
    { name: "description", content: "Inspect workflow state by organisation and fragment scope." },
  ];
}

export default function BackofficeWorkflowsLanding() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const organizations = me.organizations ?? [];
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Workflows" },
        ]}
        eyebrow="Internals"
        title="Workflow state by scope."
        description="Select an organisation to inspect workflow instances, steps, and event history."
        actions={
          <Link
            to="/backoffice/internals"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to internals
          </Link>
        }
      />

      <div className="space-y-2">
        <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">Scopes</p>
        {organizations.length === 0 ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
            No organisations are linked to this account yet.
          </div>
        ) : (
          <section className="grid gap-3 md:grid-cols-3">
            {organizations.map(({ organization }) => {
              const piPath = `/backoffice/internals/workflows/${organization.id}/pi`;
              const automationsPath = `/backoffice/internals/workflows/${organization.id}/automations`;
              const handleOrgClick = () => {
                navigate(piPath);
              };

              return (
                <div
                  key={organization.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${organization.name} workflows`}
                  onClick={handleOrgClick}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleOrgClick();
                    }
                  }}
                  className="flex h-full cursor-pointer flex-col border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 transition-colors hover:border-[color:var(--bo-border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                >
                  <div>
                    <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                      {organization.slug}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                      {organization.name}
                    </h2>
                  </div>

                  <p className="mt-4 text-sm text-[var(--bo-muted)]">
                    Inspect workflow instances, current step state, and event history.
                  </p>

                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                    <Link
                      to={piPath}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Pi
                    </Link>
                    <Link
                      to={automationsPath}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Automations
                    </Link>
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
}
