// oxlint-disable-next-line typescript/triple-slash-reference -- Published codemode declarations define globals, not an importable module.
/// <reference path="../../../content/static/codemode/providers/packages.d.ts" />
// oxlint-disable-next-line typescript/triple-slash-reference -- Published codemode declarations define globals, not an importable module.
/// <reference path="../../../content/static/codemode/providers/marketplace.d.ts" />

import { describe, expect, expectTypeOf, test, assert } from "vitest";

import { createCodemodeTypeFiles } from "@/fragno/codemode/codemode-dts";

import { createRuntimeToolFamilyReference, toRuntimeToolReference } from "./reference";
import type { BackofficeRuntimeToolFamily } from "./runtime-tools";
import { runtimeToolFamilies } from "./tool-families";

const summarizeFamilyReference = (family: BackofficeRuntimeToolFamily) => {
  const reference = createRuntimeToolFamilyReference({ family });
  return {
    namespace: reference.namespace,
    tools: reference.tools.map((tool) => ({
      id: tool.id,
      namespace: tool.namespace,
      codemodeProvider: tool.codemode.providerName,
      codemodeTool: tool.codemode.toolName,
      inputType: tool.codemode.inputTypeName,
      outputType: tool.codemode.outputTypeName,
      bashCommand: tool.bash?.command,
      bashOptions: tool.bash?.options.map((option) => option.name) ?? [],
    })),
  };
};

const findBashFamily = (namespace: string): BackofficeRuntimeToolFamily => {
  const families = runtimeToolFamilies.filter((candidate) => candidate.namespace === namespace);
  if (!families.length) {
    throw new Error(`Missing bash family '${namespace}'`);
  }
  return {
    namespace,
    tools: families.flatMap((family) => family.tools),
  };
};

describe("runtime tool reference generation", () => {
  test("publishing declarations expose concrete paths, System overrides, and asynchronous workflow references", () => {
    expectTypeOf<MarketplacePublishInput["packageRoot"]>().toEqualTypeOf<string>();
    expectTypeOf<
      Extract<MarketplacePublishOutput, { state: "requested" | "published" }>["workflowScope"]
    >().toEqualTypeOf<{ kind: "system" }>();
    const reference = createRuntimeToolFamilyReference({ family: findBashFamily("marketplace") });
    const publish = reference.tools.find((tool) => tool.id === "marketplace.publish");
    assert(publish);
    expect(publish.bash?.options.map((option) => option.name)).toEqual([
      "package-root",
      "visibility",
      "dry-run",
      "skip-author-check",
      "skip-version-check",
    ]);
    assert(publish.codemode.inputType.includes("packageRoot: string;"));
    assert(!publish.codemode.inputType.includes("packageRoot: unknown;"));
  });
  test("generated package installation paths can be passed to filesystem tools", () => {
    expectTypeOf<PackagesInstallOutput["installationRoot"]>().toEqualTypeOf<string>();
    expectTypeOf<
      PackagesLsOutput["installations"][number]["installationRoot"]
    >().toEqualTypeOf<string>();
    const reference = createRuntimeToolFamilyReference({ family: findBashFamily("packages") });
    for (const tool of reference.tools) {
      assert(tool.codemode.outputType.includes("installationRoot: string;"));
      assert(!tool.codemode.outputType.includes("installationRoot: unknown;"));
    }
  });
  test.each([
    {
      namespace: "store",
      tools: [
        {
          id: "store.get",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "get",
          inputType: "StoreGetInput",
          outputType: "StoreGetOutput",
          bashCommand: "store.get",
          bashOptions: ["key"],
        },
        {
          id: "store.set",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "set",
          inputType: "StoreSetInput",
          outputType: "StoreSetOutput",
          bashCommand: "store.set",
          bashOptions: ["key", "value", "description", "category", "verification"],
        },
        {
          id: "store.delete",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "delete",
          inputType: "StoreDeleteInput",
          outputType: "StoreDeleteOutput",
          bashCommand: "store.delete",
          bashOptions: ["key"],
        },
        {
          id: "store.list",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "list",
          inputType: "StoreListInput",
          outputType: "StoreListOutput",
          bashCommand: "store.list",
          bashOptions: ["prefix", "limit"],
        },
      ],
    },
    {
      namespace: "events",
      tools: [
        {
          id: "events.fire",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "fire",
          inputType: "EventsFireInput",
          outputType: "EventsFireOutput",
          bashCommand: "events.fire",
          bashOptions: [
            "event-type",
            "source",
            "subject-user-id",
            "payload-json",
            "target-scope-json",
          ],
        },
        {
          id: "events.list",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "list",
          inputType: "EventsListInput",
          outputType: "EventsListOutput",
          bashCommand: "events.list",
          bashOptions: ["limit", "cursor"],
        },
        {
          id: "events.get",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "get",
          inputType: "EventsGetInput",
          outputType: "EventsGetOutput",
          bashCommand: "events.get",
          bashOptions: ["id"],
        },
        {
          id: "events.routes.list",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "routesList",
          inputType: "EventsRoutesListInput",
          outputType: "EventsRoutesListOutput",
          bashCommand: "events.routes.list",
          bashOptions: ["status", "limit", "cursor"],
        },
        {
          id: "events.routes.retry",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "routesRetry",
          inputType: "EventsRoutesRetryInput",
          outputType: "EventsRoutesRetryOutput",
          bashCommand: "events.routes.retry",
          bashOptions: ["event", "route"],
        },
        {
          id: "events.catalog.list",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogList",
          inputType: "EventsCatalogListInput",
          outputType: "EventsCatalogListOutput",
          bashCommand: "events.catalog.list",
          bashOptions: [],
        },
        {
          id: "events.catalog.get",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogGet",
          inputType: "EventsCatalogGetInput",
          outputType: "EventsCatalogGetOutput",
          bashCommand: "events.catalog.get",
          bashOptions: ["source", "event-type"],
        },
        {
          id: "events.catalog.create",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogCreate",
          inputType: "EventsCatalogCreateInput",
          outputType: "EventsCatalogCreateOutput",
          bashCommand: "events.catalog.create",
          bashOptions: ["json"],
        },
      ],
    },
    {
      namespace: "hooks",
      tools: [
        {
          id: "hooks.list",
          namespace: "hooks",
          codemodeProvider: "hooks",
          codemodeTool: "list",
          inputType: "HooksListInput",
          outputType: "HooksListOutput",
          bashCommand: "hooks.list",
          bashOptions: ["fragment", "cursor", "page-size"],
        },
        {
          id: "hooks.get",
          namespace: "hooks",
          codemodeProvider: "hooks",
          codemodeTool: "get",
          inputType: "HooksGetInput",
          outputType: "HooksGetOutput",
          bashCommand: "hooks.get",
          bashOptions: ["fragment", "hook-id"],
        },
      ],
    },
    {
      namespace: "otp",
      tools: [
        {
          id: "otp.identity.create-claim",
          namespace: "otp",
          codemodeProvider: "otp",
          codemodeTool: "createIdentityClaim",
          inputType: "OtpCreateIdentityClaimInput",
          outputType: "OtpCreateIdentityClaimOutput",
          bashCommand: "otp.identity.create-claim",
          bashOptions: ["ttl-minutes"],
        },
      ],
    },
    {
      namespace: "pi",
      tools: [
        {
          id: "pi.agent.list",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "listAgents",
          inputType: "PiListAgentsInput",
          outputType: "PiListAgentsOutput",
          bashCommand: "pi.agent.list",
          bashOptions: [],
        },
        {
          id: "pi.agent.get",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "getAgent",
          inputType: "PiGetAgentInput",
          outputType: "PiGetAgentOutput",
          bashCommand: "pi.agent.get",
          bashOptions: ["agent"],
        },
        {
          id: "pi.agent.messages",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "listMessages",
          inputType: "PiListMessagesInput",
          outputType: "PiListMessagesOutput",
          bashCommand: "pi.agent.messages",
          bashOptions: ["agent", "last", "before", "subagent"],
        },
        {
          id: "pi.agent.export",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "exportConversation",
          inputType: "PiExportConversationInput",
          outputType: "PiExportConversationOutput",
          bashCommand: "pi.agent.export",
          bashOptions: ["agent", "output", "history"],
        },
        ...(["create", "update"] as const).map((operation) => ({
          id: `pi.agent.${operation}`,
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: `${operation}Agent`,
          inputType: `Pi${operation === "create" ? "Create" : "Update"}AgentInput`,
          outputType: `Pi${operation === "create" ? "Create" : "Update"}AgentOutput`,
          bashCommand: `pi.agent.${operation}`,
          bashOptions: [
            "agent",
            "description",
            "instructions",
            "permission",
            "model",
            "managed-by",
          ],
        })),
        {
          id: "pi.agent.delete",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "deleteAgent",
          inputType: "PiDeleteAgentInput",
          outputType: "PiDeleteAgentOutput",
          bashCommand: "pi.agent.delete",
          bashOptions: ["agent"],
        },
        {
          id: "pi.prompt.submit",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "submitPrompt",
          inputType: "PiSubmitPromptInput",
          outputType: "PiSubmitPromptOutput",
          bashCommand: "pi.prompt.submit",
          bashOptions: [
            "agent",
            "content",
            "request-id",
            "when-busy",
            "notify-when-done",
            "subagent",
            "billing-organization-id",
          ],
        },
        {
          id: "pi.prompt.get",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "getPrompt",
          inputType: "PiGetPromptInput",
          outputType: "PiGetPromptOutput",
          bashCommand: "pi.prompt.get",
          bashOptions: ["agent", "request-id"],
        },
        {
          id: "pi.agent.stop",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "stopAgent",
          inputType: "PiStopAgentInput",
          outputType: "PiStopAgentOutput",
          bashCommand: "pi.agent.stop",
          bashOptions: ["agent"],
        },
        {
          id: "pi.agent.backfillEvents",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "backfillAgentEvents",
          inputType: "PiBackfillAgentEventsInput",
          outputType: "PiBackfillAgentEventsOutput",
          bashCommand: "pi.agent.backfillEvents",
          bashOptions: [],
        },
      ],
    },
  ])("converts $namespace family tools into reference objects", (expectedFamily) => {
    const family = findBashFamily(expectedFamily.namespace);

    expect(summarizeFamilyReference(family)).toEqual(expectedFamily);
    expect(family.tools.map(toRuntimeToolReference)).toEqual(
      createRuntimeToolFamilyReference({ family }).tools,
    );
  });

  test("renders the state provider at its canonical declaration path", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
    });

    assert(files.some((file) => file.path === "/static/codemode/providers/state.d.ts"));
    assert(!files.some((file) => file.path === "/static/codemode/state.d.ts"));
  });

  test("renders void-input tools as zero-argument methods", () => {
    const file = createCodemodeTypeFiles({ families: runtimeToolFamilies }).find(
      (candidate) => candidate.path === "/static/codemode/providers/integrations.d.ts",
    );
    assert(file);

    expect(file.content).toContain("discover(): Promise<IntegrationsDiscoverOutput>;");
    expect(file.content).not.toContain("IntegrationsDiscoverInput");
  });
});
