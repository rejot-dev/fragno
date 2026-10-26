import { describe, expect, onTestFinished, test } from "vitest";

import type { PiAgentDefinitionCreate } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";

import { applyPackageAgents, removePackageAgents } from "./package-agents";
import { piManagerDefinition } from "./pi-manager-definition";
import { piManagerDirectoryRoutes } from "./pi-manager-directory-routes";
import { piAgentDirectorySchema } from "./pi-manager-schema";

const SCOPE: BackofficeContextScope = { kind: "org", orgId: "package-agents-org" };
const LISTING_ID = "system#telegram-channel";
const OTHER_LISTING_ID = "system#other-channel";

const { actors } = createBackofficeServiceExecution({
  scope: SCOPE,
  service: { type: "automation", id: "package-agents-test" },
});
const provenance = { actors, scopeRestriction: null };

const telegram: PiAgentDefinitionCreate = {
  agentName: "telegram",
  description: "Answers messages from Telegram chats.",
  model: null,
  permissions: ["*"],
  instructions: "Keep answers short.",
};

async function piManager() {
  const { fragments, test: database } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "piManager",
      instantiate(piManagerDefinition)
        .withConfig({
          scope: SCOPE,
          agent: () => {
            throw new Error("Package agent tests run no turns.");
          },
          supportedAvailableModels: async () => [],
          billing: () => {
            throw new Error("Package agent tests bill nothing.");
          },
          automations: null,
        })
        .withRoutes([piManagerDirectoryRoutes]),
    )
    .build();
  onTestFinished(async () => {
    await database.cleanup();
  });
  return fragments.piManager.fragment;
}

type PiManagerFragment = Awaited<ReturnType<typeof piManager>>;

function apply(
  fragment: PiManagerFragment,
  agents: PiAgentDefinitionCreate[],
  listingId = LISTING_ID,
) {
  return applyPackageAgents(fragment, { listingId, agents, actors });
}

async function readAgents(fragment: PiManagerFragment) {
  const agents = await fragment.callServices(() => fragment.services.listAgents());
  return agents.map(({ agentName, instructions, steward }) => ({
    agentName,
    instructions,
    steward,
  }));
}

/** Writes an agent as install scripts did before stewardship, labelled with `managedBy`. */
async function seedLegacyLabelledAgent(fragment: PiManagerFragment, listingId: string) {
  const { agentName, ...fields } = telegram;
  await fragment.inContext(async function () {
    await this.handlerTx()
      .mutate(({ forSchema }) => {
        forSchema(piAgentDirectorySchema).create("agent_definition", {
          id: agentName,
          ...fields,
          instructions: "Old instructions.",
          managedBy: {
            kind: "marketplace",
            listingId,
            resourceKey: "telegram-agent",
            version: "2.0.0",
          },
          steward: null,
        });
      })
      .execute();
  });
}

describe("package agents", () => {
  test("a package defines, updates, and deletes its agents, which members can't change", async () => {
    const fragment = await piManager();
    await expect(apply(fragment, [telegram])).resolves.toEqual({ ok: true });
    expect(await readAgents(fragment)).toEqual([
      { agentName: "assistant", instructions: "", steward: { kind: "backoffice" } },
      {
        agentName: "telegram",
        instructions: "Keep answers short.",
        steward: { kind: "package", listingId: LISTING_ID },
      },
    ]);

    const { agentName: _agentName, ...fields } = telegram;
    const replaced = await fragment.callRoute("PUT", "/agents/:agentName", {
      pathParams: { agentName: "telegram" },
      body: { ...fields, instructions: "Answer at length.", provenance },
    });
    const refusal = {
      code: "AGENT_STEWARDED",
      message: `Pi agent 'telegram' is managed by package '${LISTING_ID}'. Install the package again to change it, or uninstall the package to remove it.`,
    };
    expect(replaced).toMatchObject({ type: "error", status: 409, error: refusal });
    const deleted = await fragment.callRoute("DELETE", "/agents/:agentName", {
      pathParams: { agentName: "telegram" },
      body: { provenance },
    });
    expect(deleted).toMatchObject({ type: "error", status: 409, error: refusal });

    await expect(
      apply(fragment, [{ ...telegram, instructions: "Answer in one sentence." }]),
    ).resolves.toEqual({ ok: true });
    expect((await readAgents(fragment)).at(-1)).toMatchObject({
      instructions: "Answer in one sentence.",
    });

    // Another package's agents are left alone; a release without the agent deletes it.
    await apply(fragment, [{ ...telegram, agentName: "other" }], OTHER_LISTING_ID);
    await expect(apply(fragment, [])).resolves.toEqual({ ok: true });
    expect((await readAgents(fragment)).map(({ agentName }) => agentName)).toEqual([
      "assistant",
      "other",
    ]);
    await expect(
      removePackageAgents(fragment, { listingId: OTHER_LISTING_ID, actors }),
    ).resolves.toEqual(["other"]);
    expect((await readAgents(fragment)).map(({ agentName }) => agentName)).toEqual(["assistant"]);
  });

  test("a package takes over the agent its pre-stewardship install script labelled", async () => {
    const fragment = await piManager();
    await seedLegacyLabelledAgent(fragment, LISTING_ID);
    expect((await readAgents(fragment)).at(-1)?.steward).toEqual({ kind: "members" });

    await expect(apply(fragment, [telegram])).resolves.toEqual({ ok: true });
    expect((await readAgents(fragment)).at(-1)).toEqual({
      agentName: "telegram",
      instructions: "Keep answers short.",
      steward: { kind: "package", listingId: LISTING_ID },
    });
  });

  test("a package refuses agents it doesn't steward, unless it leaves a members' agent unchanged", async () => {
    const labelled = await piManager();
    await seedLegacyLabelledAgent(labelled, OTHER_LISTING_ID);
    await expect(apply(labelled, [telegram])).resolves.toEqual({
      ok: false,
      message: `Pi agent 'telegram' already exists and is not managed by package '${LISTING_ID}'.`,
    });

    const fragment = await piManager();
    const created = await fragment.callRoute("POST", "/agents", {
      body: { ...telegram, provenance },
    });
    expect(created).toMatchObject({ status: 201 });
    await expect(apply(fragment, [{ ...telegram, instructions: "Changed." }])).resolves.toEqual({
      ok: false,
      message: `Pi agent 'telegram' already exists and is not managed by package '${LISTING_ID}'.`,
    });
    await expect(apply(fragment, [telegram])).resolves.toEqual({ ok: true });
    expect((await readAgents(fragment)).at(-1)?.steward).toEqual({
      kind: "package",
      listingId: LISTING_ID,
    });

    await expect(apply(fragment, [{ ...telegram, agentName: "assistant" }])).resolves.toEqual({
      ok: false,
      message: "Pi agent 'assistant' is built into Backoffice and cannot change.",
    });
  });
});
