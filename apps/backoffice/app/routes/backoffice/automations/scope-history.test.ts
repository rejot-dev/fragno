import { assert, describe, test } from "vitest";

import {
  automationScopeTabPath,
  automationUiScopeId,
  resolveAutomationScopeTab,
  type AutomationUiScope,
} from "./scope";
import {
  advanceAutomationScopeHistory,
  parseAutomationScopeHistory,
  type AutomationScopeHistory,
} from "./scope-history";

const projectInFirstOrganisation: AutomationUiScope = {
  kind: "project",
  orgId: "org-one",
  projectId: "project-one",
  label: "First project",
};
const secondOrganisation: AutomationUiScope = {
  kind: "org",
  orgId: "org-two",
  label: "Second organisation",
};
const personalScope: AutomationUiScope = {
  kind: "user",
  userId: "user-one",
  label: "person@example.com",
};

describe("automation scope history", () => {
  test("restores the previous scope when the selected scope matches stored history", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 1,
      current: secondOrganisation,
      previous: projectInFirstOrganisation,
    };

    assert.deepEqual(
      advanceAutomationScopeHistory(storedHistory, secondOrganisation).previous,
      projectInFirstOrganisation,
    );
  });

  test("preserves the complete previous project across organisation switches", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 1,
      current: projectInFirstOrganisation,
      previous: personalScope,
    };

    assert.deepEqual(advanceAutomationScopeHistory(storedHistory, secondOrganisation), {
      version: 1,
      current: secondOrganisation,
      previous: projectInFirstOrganisation,
    });
  });

  test("reconstructs a previous project destination without current organisation options", () => {
    assert.equal(
      automationScopeTabPath(projectInFirstOrganisation, "dashboard"),
      "/backoffice/automations/project/org-one%3Aproject-one/dashboard",
    );
    assert.notEqual(
      automationUiScopeId(projectInFirstOrganisation),
      automationUiScopeId({
        ...projectInFirstOrganisation,
        orgId: "org-two",
      }),
    );
  });

  test("falls back to scripts when a previous system scope cannot open the active tab", () => {
    assert.equal(resolveAutomationScopeTab({ kind: "system", label: "System" }, "api"), "scripts");
    assert.equal(resolveAutomationScopeTab(secondOrganisation, "api"), "api");
  });

  test("reverses the history when browser navigation returns to the previous scope", () => {
    const storedHistory: AutomationScopeHistory = {
      version: 1,
      current: secondOrganisation,
      previous: projectInFirstOrganisation,
    };

    assert.deepEqual(advanceAutomationScopeHistory(storedHistory, projectInFirstOrganisation), {
      version: 1,
      current: projectInFirstOrganisation,
      previous: secondOrganisation,
    });
  });

  test("rejects malformed and outdated browser storage", () => {
    assert.isNull(parseAutomationScopeHistory("not json"));
    assert.isNull(
      parseAutomationScopeHistory(
        JSON.stringify({
          version: 0,
          current: secondOrganisation,
          previous: projectInFirstOrganisation,
        }),
      ),
    );
    assert.isNull(
      parseAutomationScopeHistory(
        JSON.stringify({
          version: 1,
          current: { kind: "project", projectId: "missing-org", label: "Invalid" },
          previous: null,
        }),
      ),
    );
  });
});
