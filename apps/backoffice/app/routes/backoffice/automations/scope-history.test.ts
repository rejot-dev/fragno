import { assert, describe, test } from "vitest";

import {
  type BackofficeScopeSelection,
  backofficeResolvedScopeId,
} from "@/backoffice-runtime/resolved-scope";

import { automationScopeTabPath, resolveAutomationScopeTab } from "./scope";
import {
  advanceAutomationScopeHistory,
  parseAutomationScopeHistory,
  type AutomationScopeHistory,
} from "./scope-history";

const projectInFirstOrganization: BackofficeScopeSelection = {
  kind: "project",
  organization: { id: "org-one", slug: "first-org" },
  projectId: "project-one",
  label: "First project",
};
const secondOrganization: BackofficeScopeSelection = {
  kind: "org",
  organization: { id: "org-two", slug: "second-org" },
  label: "Second organization",
};
const personalScope: BackofficeScopeSelection = {
  kind: "user",
  userId: "user-one",
  label: "person@example.com",
};

describe("automation scope history", () => {
  test("restores the previous scope when the selected scope matches stored history", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 2,
      current: secondOrganization,
      previous: projectInFirstOrganization,
    };

    assert.deepEqual(
      advanceAutomationScopeHistory(storedHistory, secondOrganization).previous,
      projectInFirstOrganization,
    );
  });

  test("preserves the complete previous project across organization switches", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 2,
      current: projectInFirstOrganization,
      previous: personalScope,
    };

    assert.deepEqual(advanceAutomationScopeHistory(storedHistory, secondOrganization), {
      version: 2,
      current: secondOrganization,
      previous: projectInFirstOrganization,
    });
  });

  test("reconstructs a previous project destination without current organization options", () => {
    assert.equal(
      automationScopeTabPath(projectInFirstOrganization, "dashboard"),
      "/backoffice/automations/project/first-org%3Aproject-one/dashboard",
    );
    assert.notEqual(
      backofficeResolvedScopeId(projectInFirstOrganization),
      backofficeResolvedScopeId({
        ...projectInFirstOrganization,
        organization: { id: "org-two", slug: "second-org" },
      }),
    );
  });

  test("falls back to the dashboard when a system scope cannot open the active tab", () => {
    assert.equal(
      resolveAutomationScopeTab({ kind: "system", label: "System" }, "api"),
      "dashboard",
    );
    assert.equal(resolveAutomationScopeTab(secondOrganization, "api"), "api");
  });

  test("reverses the history when browser navigation returns to the previous scope", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 2,
      current: secondOrganization,
      previous: projectInFirstOrganization,
    };

    assert.deepEqual(advanceAutomationScopeHistory(storedHistory, projectInFirstOrganization), {
      version: 2,
      current: projectInFirstOrganization,
      previous: secondOrganization,
    });
  });

  test("rejects malformed and outdated browser storage", () => {
    assert.isNull(parseAutomationScopeHistory("not json"));
    assert.isNull(
      parseAutomationScopeHistory(
        JSON.stringify({
          version: 1,
          current: secondOrganization,
          previous: projectInFirstOrganization,
        }),
      ),
    );
    assert.isNull(
      parseAutomationScopeHistory(
        JSON.stringify({
          version: 2,
          current: { kind: "project", projectId: "missing-org", label: "Invalid" },
          previous: null,
        }),
      ),
    );
  });
});
