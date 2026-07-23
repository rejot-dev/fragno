import { assert, describe, expect, it, vi } from "vitest";

import {
  createDurableHooksObjectOptions,
  createDurableHooksScopeOptions,
  durableHooksContextScopeFromRouteId,
  getDurableHooksLoaderErrorMessage,
  resolveDurableHooksScopeSelection,
} from "./durable-hooks-scope";

const organisations = [
  {
    id: "org_123",
    name: "Acme",
    slug: "acme",
  },
];

const projects = [
  {
    id: "project_1",
    orgId: "org_123",
    label: "Launch Plan",
    slug: "launch-plan",
  },
];

const user = {
  id: "user_1",
  email: "operator@example.com",
};

const resolveSelection = ({ scopeId, objectId }: { scopeId: string; objectId: string }) => {
  const selection = resolveDurableHooksScopeSelection({
    scopeId,
    objectId,
    organisations,
    projects,
    user,
  });
  assert(selection);
  return selection;
};

describe("durableHooksContextScopeFromRouteId", () => {
  it.each([
    ["org_123", { kind: "org", orgId: "org_123" }],
    ["user:user_1", { kind: "user", userId: "user_1" }],
    ["project:org_123:project_1", { kind: "project", orgId: "org_123", projectId: "project_1" }],
    ["singletons", { kind: "system" }],
  ])("parses %s", (scopeId, expected) => {
    expect(durableHooksContextScopeFromRouteId(scopeId)).toEqual(expected);
  });
});

describe("resolveDurableHooksScopeSelection", () => {
  it("resolves organisation, project, user, and singleton scopes", () => {
    expect(resolveSelection({ scopeId: "org_123", objectId: "api" })).toMatchObject({
      kind: "org",
      orgId: "org_123",
      objectId: "api",
    });
    expect(
      resolveSelection({ scopeId: "project:org_123:project_1", objectId: "upload" }),
    ).toMatchObject({
      kind: "project",
      orgId: "org_123",
      projectId: "project_1",
      label: "Launch Plan",
      objectId: "upload",
    });
    expect(resolveSelection({ scopeId: "user:user_1", objectId: "mcp" })).toMatchObject({
      kind: "user",
      userId: "user_1",
      label: "operator@example.com",
      objectId: "mcp",
    });
    expect(resolveSelection({ scopeId: "singletons", objectId: "auth" })).toMatchObject({
      kind: "singleton",
      objectId: "auth",
    });
  });

  it("rejects objects that the registry policy does not allow for the selected scope", () => {
    expect(
      resolveDurableHooksScopeSelection({
        scopeId: "user:user_1",
        objectId: "auth",
        organisations,
        projects,
        user,
      }),
    ).toBeNull();
    expect(
      resolveDurableHooksScopeSelection({
        scopeId: "singletons",
        objectId: "api",
        organisations,
        projects,
        user,
      }),
    ).toBeNull();
  });
});

describe("durable hook selectors", () => {
  it("derives each scope's object options from the object registry policy", () => {
    expect(
      createDurableHooksObjectOptions(
        resolveSelection({ scopeId: "singletons", objectId: "auth" }),
      ).map((option) => option.id),
    ).toEqual(["auth", "automations", "telegram", "otp", "resend"]);

    expect(
      createDurableHooksObjectOptions(
        resolveSelection({ scopeId: "org_123", objectId: "api" }),
      ).map((option) => option.id),
    ).toEqual([
      "api",
      "automations",
      "telegram",
      "otp",
      "resend",
      "mcp",
      "upload",
      "github",
      "pi",
      "pi-workflows",
    ]);

    const userObjects = createDurableHooksObjectOptions(
      resolveSelection({ scopeId: "user:user_1", objectId: "api" }),
    ).map((option) => option.id);
    const projectObjects = createDurableHooksObjectOptions(
      resolveSelection({ scopeId: "project:org_123:project_1", objectId: "api" }),
    ).map((option) => option.id);
    expect(userObjects).toEqual(["api", "automations", "telegram", "mcp", "upload"]);
    expect(projectObjects).toEqual(userObjects);
  });

  it("includes project and user scopes while preserving a compatible object", () => {
    const selection = resolveSelection({ scopeId: "org_123", objectId: "telegram" });

    expect(createDurableHooksScopeOptions({ organisations, projects, user, selection })).toEqual([
      {
        id: "singleton:singletons",
        kind: "singleton",
        label: "Singleton",
        description: "Global durable object scope",
        to: "/backoffice/internals/durable-hooks/singletons/telegram",
      },
      {
        id: "org:org_123",
        kind: "org",
        label: "Acme",
        description: "Organisation · acme",
        to: "/backoffice/internals/durable-hooks/org_123/telegram",
      },
      {
        id: "project:org_123:project_1",
        kind: "project",
        label: "Launch Plan",
        description: "Project · launch-plan",
        to: "/backoffice/internals/durable-hooks/project:org_123:project_1/telegram",
      },
      {
        id: "user:user_1",
        kind: "user",
        label: "operator@example.com",
        description: "Personal user scope",
        to: "/backoffice/internals/durable-hooks/user:user_1/telegram",
      },
    ]);
  });

  it("falls back to the first object allowed by the destination scope", () => {
    const selection = resolveSelection({ scopeId: "org_123", objectId: "github" });
    const options = createDurableHooksScopeOptions({ organisations, projects, user, selection });

    assert.equal(
      options.find((option) => option.kind === "user")?.to,
      "/backoffice/internals/durable-hooks/user:user_1/api",
    );
    assert.equal(
      options.find((option) => option.kind === "singleton")?.to,
      "/backoffice/internals/durable-hooks/singletons/auth",
    );
  });
});

describe("getDurableHooksLoaderErrorMessage", () => {
  it("returns a fixed upload error while logging the scoped object failure", () => {
    const logError = vi.fn();
    const error = new Error("Missing storage credentials");
    const selection = resolveSelection({ scopeId: "user:user_1", objectId: "upload" });

    const message = getDurableHooksLoaderErrorMessage({ selection, error, logError });

    expect(message).toBe("Upload service unavailable");
    expect(logError).toHaveBeenCalledWith("Failed to load Upload durable hooks", {
      scopeId: "user:user_1",
      objectId: "upload",
      error,
    });
  });
});
