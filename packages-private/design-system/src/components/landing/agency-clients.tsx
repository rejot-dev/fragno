import { Icon } from "../icon";
import { LandingSection } from "./landing-section";

type ClientOrganization = {
  name: string;
  members: number;
  automations: number;
  connections: string;
};

const AGENCY = { name: "Northwind Studio", people: ["AK", "MB", "JS", "RV"] } as const;

const CLIENTS: readonly ClientOrganization[] = [
  { name: "Harbor Booking", members: 3, automations: 12, connections: "Slack, email" },
  { name: "Juniper Legal", members: 5, automations: 7, connections: "GitHub, Stripe" },
  { name: "Olive & Co.", members: 2, automations: 9, connections: "Email, Shopify" },
];

/** Shows an agency above its client organizations, each kept apart but reachable by its team. */
export function LandingAgencyClients() {
  return (
    <LandingSection
      id="landing-agency-clients"
      title="Run Backoffice for your clients."
      visual={
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-5 sm:p-8">
          <div className="mx-auto flex max-w-sm items-center gap-4 border border-[color:var(--bo-accent)] bg-[var(--bo-panel)] p-4 shadow-[var(--bo-panel-shadow)]">
            <span className="grid size-10 shrink-0 place-items-center bg-[var(--bo-accent-bg)] text-[var(--bo-accent-strong)]">
              <Icon name="briefcase" className="size-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold">{AGENCY.name}</span>
              <span className="block text-xs text-[var(--bo-muted)]">Your agency</span>
            </span>
            <span className="flex -space-x-1.5" aria-label={`${AGENCY.people.length} people`}>
              {AGENCY.people.map((initials) => (
                <span
                  key={initials}
                  className="grid size-7 place-items-center rounded-full border-2 border-[color:var(--bo-panel)] bg-[var(--bo-panel-2)] text-[9px] font-semibold text-[var(--bo-muted)]"
                >
                  {initials}
                </span>
              ))}
            </span>
          </div>

          {/* The rule from the agency fans out to its clients, which reads as "manages". */}
          <div aria-hidden="true" className="mx-auto h-8 w-px bg-[var(--bo-border-strong)]" />
          <div
            aria-hidden="true"
            className="mx-auto hidden h-px w-[66.6%] bg-[var(--bo-border-strong)] md:block"
          />

          <ul className="grid gap-4 md:grid-cols-3">
            {CLIENTS.map((client) => (
              <li key={client.name} className="flex flex-col">
                <span
                  aria-hidden="true"
                  className="mx-auto hidden h-6 w-px bg-[var(--bo-border-strong)] md:block"
                />
                <article className="flex-1 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
                  <h3 className="text-sm font-semibold">{client.name}</h3>
                  <p className="mt-1 text-xs text-[var(--bo-muted)]">Managed by {AGENCY.name}</p>
                  <dl className="mt-4 space-y-1.5 border-t border-[color:var(--bo-border)] pt-3 text-xs">
                    <ClientFact label="Own members" value={String(client.members)} />
                    <ClientFact label="Automations" value={String(client.automations)} />
                    <ClientFact label="Connections" value={client.connections} />
                  </dl>
                </article>
              </li>
            ))}
          </ul>
        </div>
      }
    >
      Agencies manage client organizations from one account. Each client keeps its own data,
      members, and automations. Your team works in every client without being invited to each one,
      and the client&rsquo;s own owners stay in charge.
    </LandingSection>
  );
}

function ClientFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--bo-muted)]">{label}</dt>
      <dd className="truncate text-right tabular-nums">{value}</dd>
    </div>
  );
}
