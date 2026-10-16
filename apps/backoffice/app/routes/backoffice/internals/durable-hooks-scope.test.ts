import { assert, describe, expect, it, vi } from "vitest";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";

import {
  createDurableHooksObjectOptions,
  getDurableHooksLoaderErrorMessage,
  resolveDurableHooksScopeSelection,
} from "./durable-hooks-scope";

const acme = { id: "org_123", slug: "acme" };
const systemScope: BackofficeScopeSelection = { kind: "system", label: "System" };
const orgScope: BackofficeScopeSelection = { kind: "org", organization: acme, label: "Acme" };
const projectScope: BackofficeScopeSelection = {
  kind: "project",
  organization: acme,
  projectId: "project_1",
  label: "Launch Plan",
};
const userScope: BackofficeScopeSelection = {
  kind: "user",
  userId: "user_1",
  label: "operator@example.com",
};

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
    expect(resolveSelection({ scope: orgScope, objectId: "api" })).toMatchObject({
      kind: "org",
      resolvedScope: {
        kind: "org",
        organization: { id: "org_123", slug: "acme" },
      },
      objectId: "api",
    });
    expect(
      resolveSelection({
        scope: projectScope,
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
    expect(resolveSelection({ scope: userScope, objectId: "mcp" })).toMatchObject({
      kind: "user",
      resolvedScope: { kind: "user", userId: "user_1" },
      label: "operator@example.com",
      objectId: "mcp",
    });
    expect(resolveSelection({ scope: systemScope, objectId: "auth" })).toMatchObject({
      kind: "singleton",
      objectId: "auth",
    });
  });

  it("rejects objects that the registry policy does not allow for the selected scope", () => {
    expect(
      resolveDurableHooksScopeSelection({
        scope: userScope,
        objectId: "auth",
      }),
    ).toBeNull();
    expect(
      resolveDurableHooksScopeSelection({
        scope: systemScope,
        objectId: "api",
      }),
    ).toBeNull();
  });
});

describe("durable hook selectors", () => {
  it("derives each scope's object options from the object registry policy", () => {
    expect(
      createDurableHooksObjectOptions(
        resolveSelection({ scope: systemScope, objectId: "auth" }),
      ).map((option) => option.id),
    ).toEqual(["auth", "forms", "automations", "telegram", "otp", "resend", "workflows"]);

    expect(
      createDurableHooksObjectOptions(resolveSelection({ scope: orgScope, objectId: "api" })).map(
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
      resolveSelection({ scope: userScope, objectId: "api" }),
    ).map((option) => option.id);
    const projectObjects = createDurableHooksObjectOptions(
      resolveSelection({
        scope: projectScope,
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
      scope: userScope,
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
