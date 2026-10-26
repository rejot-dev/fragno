import { describe, expect, test, assert } from "vitest";

import {
  type BackofficeContextScope,
  backofficeContextScopeSchema,
  backofficeScopeContains,
  backofficeScopeIdCodec,
  backofficeScopeOrganization,
  backofficeScopeRootOwner,
  formatBackofficeScopeRoutePath,
  parseBackofficeScopeRouteParams,
  backofficeRoutableScopeSchema,
  backofficeScopePathSegment,
  BackofficeScopeParseError,
  isBackofficeScopeParseError,
  mapBackofficeScopeNames,
  parseBackofficeScopePathSegment,
} from "./scope";

describe("Backoffice scopes", () => {
  test("schemas reject unknown fields, empty ids, and system scope where resources are owned", () => {
    assert(
      !backofficeRoutableScopeSchema.safeParse({
        kind: "project",
        owner: { kind: "org", orgId: "org-1", jurisdiction: null },
        projectId: "project-1",
        ignored: true,
      }).success,
    );
    assert(!backofficeRoutableScopeSchema.safeParse({ kind: "system" }).success);
    assert(!backofficeContextScopeSchema.safeParse({ kind: "user", userId: "" }).success);
  });

  test("scopes stored before jurisdictions existed name none", () => {
    const stored = { kind: "org", orgId: "org-1" };
    expect(backofficeContextScopeSchema.parse(stored)).toEqual({
      kind: "org",
      orgId: "org-1",
      jurisdiction: null,
    });
    // Read without parsing, such as from a queued event, it still names the objects it did.
    assert(backofficeScopePathSegment(stored as BackofficeContextScope) === "org:org-1");
  });

  test.each([
    [{ kind: "system" } as const, "system"],
    [{ kind: "org", orgId: "user:alice", jurisdiction: null } as const, "org:user%3Aalice"],
    [{ kind: "user", userId: "alice", jurisdiction: null } as const, "user:alice"],
    [
      {
        kind: "project",
        owner: { kind: "org", orgId: "org:1", jurisdiction: null },
        projectId: "p/2",
      } as const,
      "project:org:org%3A1:p%2F2",
    ],
    [
      {
        kind: "app",
        owner: { kind: "user", userId: "alice", jurisdiction: null },
        appId: "app:1",
      } as const,
      "app:user:alice:app%3A1",
    ],
    [
      {
        kind: "project",
        owner: {
          kind: "app",
          owner: { kind: "org", orgId: "acme", jurisdiction: null },
          appId: "books",
        },
        projectId: "ledger",
      } as const,
      "project:app:org:acme:books:ledger",
    ],
    [
      {
        kind: "project",
        owner: { kind: "user", userId: "a@b", jurisdiction: "eu" },
        projectId: "ledger",
      } as const,
      "project:user:a%40b@eu:ledger",
    ],
  ])("round-trips path segments with encoded delimiters for %#", (scope, segment) => {
    expect(backofficeScopePathSegment(scope)).toBe(segment);
    expect(parseBackofficeScopePathSegment(segment)).toEqual(scope);
  });

  test.each([
    [{ kind: "system" } as const, "system/system"],
    [{ kind: "org", orgId: "user:alice", jurisdiction: null } as const, "org/user%253Aalice"],
    [
      {
        kind: "project",
        owner: { kind: "org", orgId: "org-1", jurisdiction: null },
        projectId: "p-2",
      } as const,
      "project/org:org-1:p-2",
    ],
    [
      {
        kind: "project",
        owner: { kind: "org", orgId: "org:1", jurisdiction: null },
        projectId: "p/2",
      } as const,
      "project/org:org%253A1:p%252F2",
    ],
    [
      {
        kind: "app",
        owner: { kind: "org", orgId: "acme", jurisdiction: null },
        appId: "books",
      } as const,
      "app/org:acme:books",
    ],
    [
      {
        kind: "app",
        owner: { kind: "org", orgId: "a@b", jurisdiction: "us" },
        appId: "books",
      } as const,
      "app/org:a%2540b@us:books",
    ],
  ])("round-trips route paths through once-decoded route params for %#", (scope, path) => {
    expect(formatBackofficeScopeRoutePath(scope, backofficeScopeIdCodec)).toBe(path);
    const [scopeKind, scopeId] = path.split("/").map(decodeURIComponent);
    expect(
      parseBackofficeScopeRouteParams(
        { scopeKind: scopeKind ?? "", scopeId: scopeId ?? "" },
        backofficeScopeIdCodec,
      ),
    ).toEqual(scope);
  });

  test("rejects malformed segments instead of guessing a scope", () => {
    expect(() => parseBackofficeScopePathSegment("project")).toThrow(
      "Project scope requires an owner scope.",
    );
    expect(() => parseBackofficeScopePathSegment("project:org:org-1")).toThrow(
      "Missing project id.",
    );
    // The segment format before projects named their owner.
    expect(() => parseBackofficeScopePathSegment("project:org-1:project-1")).toThrow(
      "Unknown scope kind 'org-1'.",
    );
    expect(() => parseBackofficeScopePathSegment("project:system:project-1")).toThrow(
      "System scope cannot own a project.",
    );
    expect(() =>
      parseBackofficeScopePathSegment("project:project:org:org-1:project-1:project-2"),
    ).toThrow("Project scope cannot own a project.");
    expect(() => parseBackofficeScopePathSegment("app:app:org:org-1:books:other")).toThrow(
      "App scope cannot own an app.",
    );
    expect(() => parseBackofficeScopePathSegment("org:org-1@mars")).toThrow(
      "Unknown jurisdiction 'mars'.",
    );
    expect(() => parseBackofficeScopePathSegment("org:org-1@eu@us")).toThrow(
      "Invalid org id jurisdiction.",
    );
    expect(() => parseBackofficeScopePathSegment("app")).toThrow(
      "App scope requires an owner scope.",
    );
    expect(() => parseBackofficeScopePathSegment("app:org:org-1")).toThrow("Missing app id.");
    expect(() => parseBackofficeScopePathSegment("project:org:org-1:project-1:extra")).toThrow(
      "Project scope has unexpected components after it.",
    );
    expect(() => parseBackofficeScopePathSegment("system:extra")).toThrow(
      "System scope has unexpected components after it.",
    );
    expect(() => parseBackofficeScopePathSegment("user:")).toThrow("Missing user id.");
    expect(() => parseBackofficeScopePathSegment("org:%E0%A4%A")).toThrow(
      "Invalid org id encoding.",
    );
    expect(() => parseBackofficeScopePathSegment("legacy-org-id")).toThrow(
      "Unknown scope kind 'legacy-org-id'.",
    );
  });

  test("a restriction contains its own scope and the projects it owns", () => {
    const acme = { kind: "org", orgId: "acme", jurisdiction: null } as const;
    const website = { kind: "project", owner: acme, projectId: "website" } as const;
    assert(backofficeScopeContains(acme, website));
    assert(backofficeScopeContains(website, website));
    assert(!backofficeScopeContains(website, acme));
    assert(!backofficeScopeContains({ kind: "org", orgId: "beta", jurisdiction: null }, website));
    assert(!backofficeScopeContains({ kind: "user", userId: "acme", jurisdiction: null }, website));
  });

  test("an organization contains neither its apps' workspaces nor their projects", () => {
    const acme = { kind: "org", orgId: "acme", jurisdiction: null } as const;
    const books = { kind: "app", owner: acme, appId: "books" } as const;
    const ledger = { kind: "project", owner: books, projectId: "ledger" } as const;
    assert(!backofficeScopeContains(acme, books));
    assert(!backofficeScopeContains(acme, ledger));
    assert(backofficeScopeContains(books, ledger));
  });

  test("follows owner chains to the organization or user that answers for a scope", () => {
    const alice = { kind: "user", userId: "alice", jurisdiction: null } as const;
    const ledger = {
      kind: "project",
      owner: { kind: "app", owner: alice, appId: "books" },
      projectId: "ledger",
    } as const;
    expect(backofficeScopeRootOwner(ledger)).toEqual(alice);
    expect(backofficeScopeOrganization(ledger)).toBeNull();
    expect(backofficeScopeRootOwner({ kind: "system" })).toBeNull();
  });

  test("renames a project's owner along with the project", () => {
    const website = {
      kind: "project",
      owner: { kind: "org", orgId: "org-1", jurisdiction: null },
      projectId: "project-1",
    } as const;
    const renamed = mapBackofficeScopeNames(website, {
      organization: ({ orgId }) => ({ orgSlug: `slug-of-${orgId}` }),
      user: ({ userId }) => ({ userId }),
      project: ({ projectId }) => ({ projectSlug: `slug-of-${projectId}` }),
    });
    expect(renamed).toEqual({
      kind: "project",
      owner: { kind: "org", orgSlug: "slug-of-org-1" },
      projectSlug: "slug-of-project-1",
    });
    expect(backofficeScopeOrganization(renamed)).toEqual({ kind: "org", orgSlug: "slug-of-org-1" });
  });

  test("recognizes parse errors across module and RPC boundaries", () => {
    assert(isBackofficeScopeParseError(new BackofficeScopeParseError("Invalid scope.")));
    assert(
      isBackofficeScopeParseError(
        Object.assign(new Error("Invalid scope."), { code: "INVALID_BACKOFFICE_SCOPE" }),
      ),
    );
    assert(!isBackofficeScopeParseError(new Error("Other failure.")));
  });
});
