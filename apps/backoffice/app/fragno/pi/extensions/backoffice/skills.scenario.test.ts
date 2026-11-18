import { expect, test } from "vitest";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

const scope = { kind: "org", orgId: "org-books", jurisdiction: null } as const;

const FILING_SKILL = `---
name: extraction
description: Read receipts the way this firm files them.
---

# Filing receipts
`;

const PLAYBOOK_SKILL = `---
name: extraction
description: Read receipts the way the playbook says.
---

# Playbook receipts
`;

test("an agent finds every skill, and is offered those it neither disables nor replaces", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "agent skills",
      objects: allLocalObjects,
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, slug: "books", name: "Books" }),
      ],
      steps: ({ then }) => [
        then.assert("the firm writes its own extraction skill and a playbook's", async (ctx) => {
          await ctx.runCodemode({
            scope,
            code: `async () => {
              await state.writeFile({
                path: "/workspace/skills/extraction/SKILL.md",
                content: ${JSON.stringify(FILING_SKILL)},
              });
              await state.writeFile({
                path: "/workspace/playbook/extraction/SKILL.md",
                content: ${JSON.stringify(PLAYBOOK_SKILL)},
              });
            }`,
          });
        }),
        then.assert(
          "a filer agent names both folders and disables the web skill and one that does not exist",
          async (ctx) => {
            await ctx.runCodemode({
              scope,
              code: `async () => await pi.createAgent({
              agentName: "filer",
              description: "Files receipts.",
              model: null,
              permissions: ["*"],
              instructions: "",
              // The workspace's own skills folder, named before the playbook, still wins.
              skills: ["/workspace/skills", "/workspace/playbook"],
              disabledSkills: ["/static/skills/web/SKILL.md", "/static/skills/gone/SKILL.md"],
            })`,
            });
          },
        ),
        then.assert(
          "the filer lists where each skill is and whether it is offered",
          async (ctx) => {
            const { result } = await ctx.runCodemode({
              scope,
              code: `async () => await pi.listAgentSkills({ agentName: "filer" })`,
            });
            expect(result).toMatchObject({
              skills: expect.arrayContaining([
                {
                  name: "web",
                  description: expect.any(String),
                  location: "/static/skills/web/SKILL.md",
                  source: { kind: "static" },
                  status: { kind: "disabled" },
                },
                {
                  name: "extraction",
                  description: expect.any(String),
                  location: "/static/skills/extraction/SKILL.md",
                  source: { kind: "static" },
                  status: { kind: "replaced", by: "/workspace/skills/extraction/SKILL.md" },
                },
                {
                  name: "extraction",
                  description: "Read receipts the way the playbook says.",
                  location: "/workspace/playbook/extraction/SKILL.md",
                  source: { kind: "folder", folder: "/workspace/playbook" },
                  status: { kind: "replaced", by: "/workspace/skills/extraction/SKILL.md" },
                },
                {
                  name: "extraction",
                  description: "Read receipts the way this firm files them.",
                  location: "/workspace/skills/extraction/SKILL.md",
                  source: { kind: "workspace" },
                  status: { kind: "offered" },
                },
                {
                  name: "workflows",
                  description: expect.any(String),
                  location: "/static/skills/workflows/SKILL.md",
                  source: { kind: "static" },
                  status: { kind: "offered" },
                },
              ]),
              problems: expect.arrayContaining([
                { path: "/static/skills/gone/SKILL.md", message: "Disabled skill not found." },
              ]),
            });
          },
        ),
        then.assert(
          "reloading offers the filer neither web nor another extraction",
          async (ctx) => {
            const { result } = await ctx.runCodemode({
              scope,
              code: `async () => (await pi.reloadAgent({ agentName: "filer" })).skills.map((skill) => skill.location)`,
            });
            expect(result).toContain("/workspace/skills/extraction/SKILL.md");
            expect(result).toContain("/static/skills/workflows/SKILL.md");
            expect(result).not.toContain("/static/skills/web/SKILL.md");
            expect(result).not.toContain("/static/skills/extraction/SKILL.md");
            expect(result).not.toContain("/workspace/playbook/extraction/SKILL.md");
          },
        ),
        then.assert("the built-in assistant is still offered web", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope,
            code: `async () => (await pi.reloadAgent({ agentName: "assistant" })).skills.map((skill) => skill.location)`,
          });
          expect(result).toContain("/static/skills/web/SKILL.md");
        }),
      ],
    }),
  );
});
