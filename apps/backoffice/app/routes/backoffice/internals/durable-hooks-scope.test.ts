import { assert, describe, expect, it, vi } from "vitest";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

import {
  createDurableHooksObjectOptions,
  getDurableHooksLoaderErrorMessage,
  resolveDurableHooksScopeSelection,
} from "./durable-hooks-scope";

const organization = { id: "org_123", slug: "acme" };
const scopes = {
  org: { kind: "org", organization, label: "Acme" },
  project: {
    kind: "project",
    owner: { kind: "org", organization },
    project: { id: "project_1", slug: "launch-plan" },
    label: "Launch Plan",
  },
  user: { kind: "user", userId: "user_1", label: "operator@example.com" },
  system: { kind: "system", label: "System" },
} satisfies Record<string, BackofficeScopeSelection>;

const resolveSelection = ({
  scope,
  objectId,
}: {
  scope: BackofficeScopeSelection;
  objectId: string;
}) => {
  const selection = resolveDurableHooksScopeSelection({ scope, objectId });
  assert(selection);
  return selection;
};

describe("resolveDurableHooksScopeSelection", () => {
  it("resolves organization, project, user, and singleton scopes", () => {
    expect(resolveSelection({ scope: scopes.org, objectId: "api" })).toMatchObject({
      kind: "org",
      resolvedScope: {
        kind: "org",
        organization: { id: "org_123", slug: "acme" },
      },
      objectId: "api",
    });
    expect(
      resolveSelection({
        scope: scopes.project,
        objectId: "upload",
      }),
    ).toMatchObject({
      kind: "project",
      resolvedScope: {
        kind: "project",
        owner: { kind: "org", organization: { id: "org_123", slug: "acme" } },
        project: { id: "project_1", slug: "launch-plan" },
      },
      label: "Launch Plan",
      objectId: "upload",
    });
    expect(resolveSelection({ scope: scopes.user, objectId: "mcp" })).toMatchObject({
      kind: "user",
      resolvedScope: { kind: "user", userId: "user_1" },
      label: "operator@example.com",
      objectId: "mcp",
    });
    expect(resolveSelection({ scope: scopes.system, objectId: "auth" })).toMatchObject({
      kind: "singleton",
      objectId: "auth",
    });
  });

  it("rejects objects that the registry policy does not allow for the selected scope", () => {
    expect(
      resolveDurableHooksScopeSelection({
        scope: scopes.user,
        objectId: "auth",
      }),
    ).toBeNull();
    expect(
      resolveDurableHooksScopeSelection({
        scope: scopes.system,
        objectId: "api",
      }),
    ).toBeNull();
  });
});

describe("durable hook selectors", () => {
  it("derives each scope's object options from the object registry policy", () => {
    expect(
      createDurableHooksObjectOptions(
        resolveSelection({ scope: scopes.system, objectId: "auth" }),
      ).map((option) => option.id),
    ).toEqual(["auth", "forms", "automations", "telegram", "otp", "resend", "workflows"]);

    expect(
      createDurableHooksObjectOptions(resolveSelection({ scope: scopes.org, objectId: "api" })).map(
        (option) => option.id,
      ),
    ).toEqual([
      "api",
      "automations",
      "telegram",
      "otp",
      "resend",
      "mcp",
      "upload",
      "github",
      "workflows",
    ]);

    const userObjects = createDurableHooksObjectOptions(
      resolveSelection({ scope: scopes.user, objectId: "api" }),
    ).map((option) => option.id);
    const projectObjects = createDurableHooksObjectOptions(
      resolveSelection({
        scope: scopes.project,
        objectId: "api",
      }),
    ).map((option) => option.id);
    expect(userObjects).toEqual(["api", "automations", "telegram", "mcp", "upload", "workflows"]);
    expect(projectObjects).toEqual(userObjects);
  });
});

describe("getDurableHooksLoaderErrorMessage", () => {
  it("returns a fixed upload error while logging the scoped object failure", () => {
    const logError = vi.fn();
    const error = new Error("Missing storage credentials");
    const selection = resolveSelection({
      scope: scopes.user,
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
