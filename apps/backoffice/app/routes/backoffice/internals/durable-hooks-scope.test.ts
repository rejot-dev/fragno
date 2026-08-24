import { assert, describe, expect, it, vi } from "vitest";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import {
  createDurableHooksObjectOptions,
  createDurableHooksScopeOptions,
  getDurableHooksLoaderErrorMessage,
  resolveDurableHooksScopeSelection,
} from "./durable-hooks-scope";

const organizations = [
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

const resolveSelection = ({
  scope,
  objectId,
}: {
  scope: BackofficeContextScope;
  objectId: string;
}) => {
  const selection = resolveDurableHooksScopeSelection({
    scope,
    objectId,
    organizations,
    projects,
    user,
  });
  assert(selection);
  return selection;
};

describe("resolveDurableHooksScopeSelection", () => {
  it("resolves organization, project, user, and singleton scopes", () => {
    expect(
      resolveSelection({ scope: { kind: "org", orgId: "org_123" }, objectId: "api" }),
    ).toMatchObject({
      kind: "org",
      resolvedScope: {
        kind: "org",
        organization: { id: "org_123", slug: "acme" },
      },
      objectId: "api",
    });
    expect(
      resolveSelection({
        scope: { kind: "project", orgId: "org_123", projectId: "project_1" },
        objectId: "upload",
      }),
    ).toMatchObject({
      kind: "project",
      resolvedScope: {
        kind: "project",
        organization: { id: "org_123", slug: "acme" },
        projectId: "project_1",
      },
      label: "Launch Plan",
      objectId: "upload",
    });
    expect(
      resolveSelection({ scope: { kind: "user", userId: "user_1" }, objectId: "mcp" }),
    ).toMatchObject({
      kind: "user",
      resolvedScope: { kind: "user", userId: "user_1" },
      label: "operator@example.com",
      objectId: "mcp",
    });
    expect(resolveSelection({ scope: { kind: "system" }, objectId: "auth" })).toMatchObject({
      kind: "singleton",
      objectId: "auth",
    });
  });

  it("rejects objects that the registry policy does not allow for the selected scope", () => {
    expect(
      resolveDurableHooksScopeSelection({
        scope: { kind: "user", userId: "user_1" },
        objectId: "auth",
        organizations,
        projects,
        user,
      }),
    ).toBeNull();
    expect(
      resolveDurableHooksScopeSelection({
        scope: { kind: "system" },
        objectId: "api",
        organizations,
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
        resolveSelection({ scope: { kind: "system" }, objectId: "auth" }),
      ).map((option) => option.id),
    ).toEqual(["auth", "automations", "telegram", "otp", "resend", "pi", "workflows"]);

    expect(
      createDurableHooksObjectOptions(
        resolveSelection({ scope: { kind: "org", orgId: "org_123" }, objectId: "api" }),
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
      "workflows",
    ]);

    const userObjects = createDurableHooksObjectOptions(
      resolveSelection({ scope: { kind: "user", userId: "user_1" }, objectId: "api" }),
    ).map((option) => option.id);
    const projectObjects = createDurableHooksObjectOptions(
      resolveSelection({
        scope: { kind: "project", orgId: "org_123", projectId: "project_1" },
        objectId: "api",
      }),
    ).map((option) => option.id);
    expect(userObjects).toEqual([
      "api",
      "automations",
      "telegram",
      "mcp",
      "upload",
      "pi",
      "workflows",
    ]);
    expect(projectObjects).toEqual(userObjects);
  });

  it("includes project and user scopes while preserving a compatible object", () => {
    const selection = resolveSelection({
      scope: { kind: "org", orgId: "org_123" },
      objectId: "telegram",
    });

    expect(createDurableHooksScopeOptions({ organizations, projects, user, selection })).toEqual([
      {
        id: "system/system",
        kind: "singleton",
        label: "Singleton",
        description: "Global durable object scope",
        to: "/backoffice/internals/durable-hooks/system/system/telegram",
      },
      {
        id: "org/org_123",
        kind: "org",
        label: "Acme",
        description: "Organization · acme",
        to: "/backoffice/internals/durable-hooks/org/acme/telegram",
      },
      {
        id: "project/org_123%3Aproject_1",
        kind: "project",
        label: "Launch Plan",
        description: "Project · launch-plan",
        to: "/backoffice/internals/durable-hooks/project/acme%3Aproject_1/telegram",
      },
      {
        id: "user/user_1",
        kind: "user",
        label: "operator@example.com",
        description: "Personal user scope",
        to: "/backoffice/internals/durable-hooks/user/user_1/telegram",
      },
    ]);
  });

  it("falls back to the first object allowed by the destination scope", () => {
    const selection = resolveSelection({
      scope: { kind: "org", orgId: "org_123" },
      objectId: "github",
    });
    const options = createDurableHooksScopeOptions({ organizations, projects, user, selection });

    assert.equal(
      options.find((option) => option.kind === "user")?.to,
      "/backoffice/internals/durable-hooks/user/user_1/api",
    );
    assert.equal(
      options.find((option) => option.kind === "singleton")?.to,
      "/backoffice/internals/durable-hooks/system/system/auth",
    );
  });
});

describe("getDurableHooksLoaderErrorMessage", () => {
  it("returns a fixed upload error while logging the scoped object failure", () => {
    const logError = vi.fn();
    const error = new Error("Missing storage credentials");
    const selection = resolveSelection({
      scope: { kind: "user", userId: "user_1" },
      objectId: "upload",
    });

    const message = getDurableHooksLoaderErrorMessage({ selection, error, logError });

    expect(message).toBe("Upload service unavailable");
    expect(logError).toHaveBeenCalledWith("Failed to load Upload durable hooks", {
      scope: { kind: "user", userId: "user_1" },
      objectId: "upload",
      error,
    });
  });
});
