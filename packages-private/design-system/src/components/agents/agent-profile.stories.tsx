import type { ReactNode } from "react";

import { AgentProfile } from "./agent-profile";
import { AgentSkillList, type AgentSkill } from "./agent-skill-list";

export default { title: "Agents/Profile" };

function builtIn(name: string, description: string, status: AgentSkill["status"]): AgentSkill {
  return {
    name,
    description,
    location: `/static/skills/${name}/SKILL.md`,
    source: { kind: "static" },
    status,
  };
}

const offered = { kind: "offered" } as const;
const disabled = { kind: "disabled" } as const;

const BUILT_IN_SKILLS: [string, string][] = [
  ["admin", "Administer Leyway: admin tools, Marketplace curation, and bundled package seeding."],
  ["api-webhooks", "Configure inbound webhooks end to end, from the URL to cataloged events."],
  [
    "building-automations",
    "Automate behavior from events or schedules with routes and saved workflows.",
  ],
  ["building-pages", "Pages that show live automation data and workspace files."],
  ["building-sites", "Web apps at an address of their own, built from site directories."],
  ["classification", "Grade data and images against a rubric with models.classify."],
  [
    "configuring-integrations",
    "Connect any service the user names: MCP servers, HTTP APIs, webhooks.",
  ],
  ["extraction", "Read PDFs and images with models.extract into JSON that matches a schema."],
  ["file-links", "Temporary URLs that download or upload workspace files without credentials."],
  [
    "image-generation",
    "Generate images with models.generateImage and write them to the workspace.",
  ],
  ["javascript-runtime", "Check, build, and run saved JavaScript modules and read their runs."],
  ["marketplace-publishing", "Publish workspace packages to Marketplace."],
  ["pi-agents", "Define, change, and prompt agents, and delegate work to subagents."],
  ["receiving-email", "Receive email at a workspace address and route it into automations."],
  ["sandbox", "Run shell work in sandboxed containers."],
  ["sending-email", "Send email from a connected address."],
  ["web", "Search the web and read pages."],
  ["workflows", "Durable workflows with steps, retries, sleeps, and waits for events."],
];

const DISABLED_FOR_FRONT_DESK = new Set(["building-sites", "marketplace-publishing", "sandbox"]);

const frontDeskSkills: AgentSkill[] = [
  ...BUILT_IN_SKILLS.map(([name, description]) =>
    builtIn(
      name,
      description,
      DISABLED_FOR_FRONT_DESK.has(name)
        ? disabled
        : name === "extraction"
          ? { kind: "replaced", by: "/workspace/skills/extraction/SKILL.md" }
          : offered,
    ),
  ),
  {
    name: "extraction",
    description: "Read receipts the way this firm files them: supplier, VAT, and the cost centre.",
    location: "/workspace/skills/extraction/SKILL.md",
    source: { kind: "workspace" },
    status: offered,
  },
  {
    name: "house-style",
    description: "How we write to customers: short, warm, and signed by the team.",
    location: "/workspace/skills/house-style/SKILL.md",
    source: { kind: "workspace" },
    status: offered,
  },
  {
    name: "client-intake",
    description: "Open a new client's file the way the accountancy that shared it does.",
    location: "/shared/acme-accountants/skills/client-intake/SKILL.md",
    source: { kind: "folder", folder: "/shared/acme-accountants/skills" },
    status: offered,
  },
  {
    name: "month-end",
    description: "The accountancy's month-end checklist, followed only when a workflow names it.",
    location: "/shared/acme-accountants/skills/month-end/SKILL.md",
    source: { kind: "folder", folder: "/shared/acme-accountants/skills" },
    status: { kind: "hidden" },
  },
];

function Page({ children }: { children: ReactNode }) {
  return <div className="p-6 sm:p-10">{children}</div>;
}

export function Assistant() {
  return (
    <Page>
      <AgentProfile
        displayName="Front Desk"
        description="Answers the team's questions about bookings, invoices, and customers, and drafts replies to customers for a person to send. It never sends email itself and asks before changing a booking."
        category={null}
        maintainer="Defined in this workspace"
        model="GPT-6.1 Sol (preferred)"
        reasoning="Low"
        permissions={["*"]}
        instructions={
          <div className="space-y-3">
            <p>Draft replies; never send them. Sign every draft as the team, not as yourself.</p>
            <p>
              When a customer asks to move a booking, check the calendar first and propose two times
              that are at least a day apart. Never cancel a booking: ask a person.
            </p>
            <p>
              Invoices: look them up by the customer&apos;s name or the invoice number. When a
              customer says they paid, check the bank feed before you say so.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Keep replies under 120 words.</li>
              <li>Answer in the language the customer wrote in.</li>
              <li>Link the invoice or booking you mention.</li>
            </ul>
          </div>
        }
        skills={<AgentSkillList skills={frontDeskSkills} problems={[]} />}
      />
    </Page>
  );
}

export function AgentWithACategory() {
  return (
    <Page>
      <AgentProfile
        displayName="Bookkeeper"
        description="Reconciles the bank feed against open invoices every night, books what matches, and leaves the rest for a person with the reason it could not match."
        category="Finance"
        maintainer="Installed by package bookkeeping"
        model="Claude Sonnet 5.5"
        reasoning="Medium"
        permissions={["store.*", "integrations.execute", "upload.read"]}
        instructions={null}
        skills={
          <AgentSkillList
            skills={BUILT_IN_SKILLS.map(([name, description]) =>
              builtIn(name, description, name === "web" ? disabled : offered),
            )}
            problems={[
              { path: "/shared/old-share/skills", message: "Folder not found." },
              { path: "/static/skills/gone/SKILL.md", message: "Disabled skill not found." },
            ]}
          />
        }
      />
    </Page>
  );
}
