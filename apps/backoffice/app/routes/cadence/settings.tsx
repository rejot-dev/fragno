import { Plus } from "lucide-react";
import { useState } from "react";
import { useOutletContext } from "react-router";

import { CadenceButton, CadencePageHeader, CadencePanel, SectionTitle } from "@/components/cadence";
import type { CadenceLayoutContext } from "@/layouts/cadence-layout";
import { cn } from "@/lib/utils";

type Section = "members" | "teams" | "projects";

const SECTIONS: { id: Section; label: string; blurb: string }[] = [
  { id: "members", label: "Members", blurb: "People with access to this workspace" },
  { id: "teams", label: "Teams", blurb: "Groups and the automations they own" },
  { id: "projects", label: "Projects", blurb: "How automations are organised" },
];

const MEMBERS = [
  { name: "Niklas Kors", role: "Owner", team: "Admin" },
  { name: "Mira Devon", role: "Admin", team: "Platform" },
  { name: "Theo Park", role: "Member", team: "Growth" },
  { name: "Ravi Anand", role: "Member", team: "Finance" },
];

const TEAMS = [
  { name: "Platform", members: 6, automations: 14 },
  { name: "Growth", members: 4, automations: 9 },
  { name: "Finance", members: 3, automations: 5 },
  { name: "Customer", members: 8, automations: 22 },
];

const PROJECTS = [
  { name: "Revenue operations", lead: "Finance", automations: 18 },
  { name: "Customer lifecycle", lead: "Growth", automations: 26 },
  { name: "Platform reliability", lead: "Platform", automations: 11 },
];

export default function SettingsPage() {
  const { me } = useOutletContext<CadenceLayoutContext>();
  const [active, setActive] = useState<Section>("members");
  const currentEmail = me?.user?.email ?? "you@cadence.studio";

  return (
    <>
      <CadencePageHeader
        eyebrow="Settings"
        title="Workspace"
        description="Manage who has access, the teams they belong to, and how automations are organised."
      />

      <div className="grid gap-2 sm:grid-cols-3">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setActive(s.id)}
            className={cn(
              "rounded-lg border px-4 py-3 text-left transition-colors",
              active === s.id
                ? "border-[color:var(--cad-brass-line)] bg-[var(--cad-brass-bg)]"
                : "border-[color:var(--cad-line)] bg-[var(--cad-panel)] hover:border-[color:var(--cad-line-strong)]",
            )}
          >
            <span
              className={cn(
                "text-sm font-medium",
                active === s.id ? "text-[var(--cad-fg)]" : "text-[var(--cad-muted)]",
              )}
            >
              {s.label}
            </span>
            <p className="mt-1 text-xs text-[var(--cad-muted-2)]">{s.blurb}</p>
          </button>
        ))}
      </div>

      {active === "members" ? (
        <section className="space-y-4">
          <SectionTitle
            eyebrow="People"
            title="Members"
            action={
              <CadenceButton type="button">
                <Plus className="h-4 w-4" />
                Invite
              </CadenceButton>
            }
          />
          <CadencePanel className="divide-y divide-[color:var(--cad-line)]">
            {MEMBERS.map((p, i) => (
              <div key={p.name} className="flex items-center justify-between px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="cad-mono flex h-9 w-9 items-center justify-center border border-[color:var(--cad-line-strong)] bg-[var(--cad-panel-2)] text-xs text-[var(--cad-muted)]">
                    {p.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-[var(--cad-fg)]">
                      {p.name}
                      {i === 0 ? (
                        <span className="cad-mono ml-2 text-[10px] text-[var(--cad-brass)]">
                          {currentEmail}
                        </span>
                      ) : null}
                    </p>
                    <p className="cad-mono text-xs text-[var(--cad-muted-2)]">{p.team}</p>
                  </div>
                </div>
                <span className="cad-eyebrow text-[var(--cad-muted)]">{p.role}</span>
              </div>
            ))}
          </CadencePanel>
        </section>
      ) : null}

      {active === "teams" ? (
        <section className="space-y-4">
          <SectionTitle
            eyebrow="Groups"
            title="Teams"
            action={
              <CadenceButton type="button">
                <Plus className="h-4 w-4" />
                New team
              </CadenceButton>
            }
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {TEAMS.map((e) => (
              <CadencePanel key={e.name} className="p-5">
                <p className="text-sm font-medium text-[var(--cad-fg)]">{e.name}</p>
                <p className="cad-mono mt-2 text-xs text-[var(--cad-muted-2)]">
                  {e.members} members · {e.automations} automations
                </p>
              </CadencePanel>
            ))}
          </div>
        </section>
      ) : null}

      {active === "projects" ? (
        <section className="space-y-4">
          <SectionTitle
            eyebrow="Organisation"
            title="Projects"
            action={
              <CadenceButton type="button">
                <Plus className="h-4 w-4" />
                New project
              </CadenceButton>
            }
          />
          <CadencePanel className="divide-y divide-[color:var(--cad-line)]">
            {PROJECTS.map((r) => (
              <div key={r.name} className="flex items-center justify-between px-5 py-4">
                <div>
                  <p className="text-sm font-medium text-[var(--cad-fg)]">{r.name}</p>
                  <p className="cad-mono text-xs text-[var(--cad-muted-2)]">
                    {r.automations} automations
                  </p>
                </div>
                <span className="cad-eyebrow text-[var(--cad-muted)]">{r.lead}</span>
              </div>
            ))}
          </CadencePanel>
        </section>
      ) : null}
    </>
  );
}
