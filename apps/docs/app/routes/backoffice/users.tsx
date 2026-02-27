import { BackofficePageHeader } from "@/components/backoffice";

const USERS = [
  {
    name: "Aly Morgan",
    role: "Platform Lead",
    org: "Fragno Labs",
    status: "Active",
  },
  {
    name: "Kenji Ruiz",
    role: "Docs Steward",
    org: "DocWorks",
    status: "Review",
  },
  {
    name: "Isha Patel",
    role: "Fragment QA",
    org: "Fragno Labs",
    status: "Active",
  },
  {
    name: "Marcos Lee",
    role: "Partner Ops",
    org: "Orbit Partners",
    status: "Limited",
  },
];

export function meta() {
  return [
    { title: "Backoffice Users" },
    { name: "description", content: "Manage backoffice users and access." },
  ];
}

export default function BackofficeUsers() {
  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[{ label: "Backoffice", to: "/backoffice" }, { label: "Users" }]}
        eyebrow="Roster"
        title="Steward access across docs and fragments."
        description="Keep access aligned with release responsibilities, audit schedules, and team structure."
      />

      <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-[var(--bo-muted-2)]">
              Active roster
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">28 contributors</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {["Invite", "Access map", "Export"].map((label) => (
              <button
                key={label}
                type="button"
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-hidden border border-[color:var(--bo-border)]">
          <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
            <thead className="bg-[var(--bo-panel-2)] text-left">
              <tr className="text-[11px] uppercase tracking-[0.22em] text-[var(--bo-muted-2)]">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Role</th>
                <th className="px-3 py-2">Organisation</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
              {USERS.map((user) => (
                <tr key={user.name} className="text-[var(--bo-muted)]">
                  <td className="px-3 py-2 font-semibold text-[var(--bo-fg)]">{user.name}</td>
                  <td className="px-3 py-2">{user.role}</td>
                  <td className="px-3 py-2">{user.org}</td>
                  <td className="px-3 py-2">
                    <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[var(--bo-muted)]">
                      {user.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
