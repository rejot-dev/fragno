import { Link, useNavigate, useOutletContext } from "react-router";
import { BackofficePageHeader } from "@/components/backoffice";
import type { BackofficeLayoutContext } from "@/layouts/backoffice-layout";

export function meta() {
  return [
    { title: "Backoffice Durable Hooks" },
    { name: "description", content: "Inspect durable hook queues by organisation." },
  ];
}

export default function BackofficeDurableHooksLanding() {
  const { me } = useOutletContext<BackofficeLayoutContext>();
  const organizations = me.organizations ?? [];
  const navigate = useNavigate();
  const handleSingletonClick = () => {
    navigate("/backoffice/internals/durable-hooks/singletons");
  };

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "Durable hooks" },
        ]}
        eyebrow="Internals"
        title="Durable hook queues by scope."
        description="Select a scope to inspect queued hooks and retry state."
        actions={
          <Link
            to="/backoffice/internals"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to internals
          </Link>
        }
      />

      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">Scopes</p>
        <section className="grid gap-3 md:grid-cols-3">
          <div
            role="button"
            tabIndex={0}
            aria-label="View singleton durable hooks"
            onClick={handleSingletonClick}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                handleSingletonClick();
              }
            }}
            className="flex h-full cursor-pointer flex-col border border-[color:var(--bo-accent)] bg-[var(--bo-panel)] p-4 shadow-[0_0_0_1px_rgba(var(--bo-accent-rgb),0.25)] transition-colors hover:border-[color:var(--bo-accent-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
          >
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                Singleton
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Singleton</h2>
            </div>
            <p className="mt-4 text-sm text-[var(--bo-muted)]">
              Review durable hooks scheduled for singleton services like authentication workflows.
            </p>
            <div className="mt-auto pt-4">
              <Link
                to="/backoffice/internals/durable-hooks/singletons"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                Auth
              </Link>
            </div>
          </div>

          {organizations.length === 0 ? (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)] md:col-span-3">
              No organisations are linked to this account yet.
            </div>
          ) : (
            organizations.map(({ organization }) => {
              const telegramPath = `/backoffice/internals/durable-hooks/${organization.id}/telegram`;
              const resendPath = `/backoffice/internals/durable-hooks/${organization.id}/resend`;
              const githubPath = `/backoffice/internals/durable-hooks/${organization.id}/github`;
              const handleOrgClick = () => {
                navigate(githubPath);
              };

              return (
                <div
                  key={organization.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${organization.name} durable hooks`}
                  onClick={handleOrgClick}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      handleOrgClick();
                    }
                  }}
                  className="flex h-full cursor-pointer flex-col border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 transition-colors hover:border-[color:var(--bo-border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
                        {organization.slug}
                      </p>
                      <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                        {organization.name}
                      </h2>
                    </div>
                  </div>

                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                    <Link
                      to={telegramPath}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Telegram
                    </Link>
                    <Link
                      to={resendPath}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      Resend
                    </Link>
                    <Link
                      to={githubPath}
                      onClick={(event) => event.stopPropagation()}
                      className="inline-flex border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    >
                      GitHub
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}
