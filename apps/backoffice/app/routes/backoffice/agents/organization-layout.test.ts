import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { RouterContextProvider } from "react-router";

import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { provideBackofficeShellRequest } from "@/layouts/backoffice-layout.test-support";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

const { fetchPiManagerAvailableModelsMock } = vi.hoisted(() => ({
  fetchPiManagerAvailableModelsMock: vi.fn(),
}));

vi.mock("./data", () => ({
  fetchPiManagerAvailableModels: fetchPiManagerAvailableModelsMock,
}));
import { loader } from "./organization-layout";
import { isPiAgentsPath } from "./path";

beforeEach(() => {
  fetchPiManagerAvailableModelsMock.mockReset();
  fetchPiManagerAvailableModelsMock.mockResolvedValue([
    {
      provider: "faux",
      modelId: "faux-1",
      label: "Faux 1",
      contextWindow: 128_000,
      thinkingLevels: ["off"],
    },
  ]);
});

const organization = {
  id: "org-123",
  slug: "wilcos-organization",
  name: "Wilco's organization",
};

function layoutContext(
  me: Pick<BackofficeMeData, "organizations" | "activeOrganization">,
  routeScope: { kind: "system" } | { kind: "org"; organization: typeof organization },
) {
  const context = new RouterContextProvider();
  context.set(BackofficeWorkerContext, { runtime: { reson8: null } } as never);
  provideBackofficeShellRequest(context, {
    me: { user: { id: "user-1" }, ...me } as BackofficeMeData,
    routeScope: routeScope as never,
  });
  return context;
}

describe("organization agents layout", () => {
  test("labels system work independently of the active organization", async () => {
    const result = await loader({
      request: new Request("http://localhost:5173/backoffice/agents/system/system/agents"),
      params: { scopeKind: "system", scopeId: "system" },
      context: layoutContext(
        { organizations: [{ organization }], activeOrganization: { organization } } as never,
        { kind: "system" },
      ),
    } as never);

    assert(result.usageLabel === "System work");
  });

  test("labels the route organization independently of the active organization", async () => {
    const result = await loader({
      request: new Request(
        "http://localhost:5173/backoffice/agents/org/wilcos-organization/agents",
      ),
      params: { scopeKind: "org", scopeId: organization.slug },
      context: layoutContext(
        { organizations: [{ organization }], activeOrganization: null } as never,
        {
          kind: "org",
          organization,
        },
      ),
    } as never);

    expect(result.usageLabel).toBe(`Usage: ${organization.name}`);
  });
});

describe("isPiAgentsPath", () => {
  const scope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgSlug: "org-1" },
    projectSlug: "project-1",
  };

  test.each([
    "/backoffice/agents/project/org:org-1:project-1/agents",
    "/backoffice/agents/project/org:org-1:project-1/agents/assistant",
    "/backoffice/agents/project/org:org-1:project-1/agents/assistant/debug",
  ])("keeps the complete agents branch in the workspace layout: %s", (pathname) => {
    assert(isPiAgentsPath(scope, pathname));
  });

  test.each(["/backoffice/agents/project/org:org-1:project-1"])(
    "does not apply the workspace layout outside the agents branch: %s",
    (pathname) => {
      assert(!isPiAgentsPath(scope, pathname));
    },
  );

  // Scope ids with reserved characters stay encoded inside the once-decoded
  // pathname; decoding again would corrupt them.
  const colonScope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgSlug: "org-1" },
    projectSlug: "a:b",
  };
  const slashScope = {
    kind: "project" as const,
    owner: { kind: "org" as const, orgSlug: "org-1" },
    projectSlug: "a/b",
  };

  test.each([
    [colonScope, "/backoffice/agents/project/org:org-1:a%253Ab/agents/assistant"],
    [colonScope, "/backoffice/agents/project/org:org-1:a%3Ab/agents/assistant"],
    [slashScope, "/backoffice/agents/project/org:org-1:a%252Fb/agents/assistant"],
    [slashScope, "/backoffice/agents/project/org:org-1:a%2Fb/agents/assistant"],
  ])("matches scope ids containing encoded characters: %o %s", (encodedScope, pathname) => {
    assert(isPiAgentsPath(encodedScope, pathname));
  });
});
