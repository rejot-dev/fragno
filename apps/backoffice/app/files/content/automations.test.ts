import { describe, expect, test } from "vitest";

import {
  STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "@/fragno/automation/content/starter-routing";
import { AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import {
  STARTER_AUTOMATION_SCRIPT_PATHS,
  WORKSPACE_STARTER_AUTOMATION_CONTENT,
} from "./starter-automations";
import { STATIC_AUTOMATION_CONTENT, STATIC_AUTOMATION_SCRIPT_PATHS } from "./static-automations";
import { SYSTEM_AUTOMATION_CONTENT, SYSTEM_AUTOMATION_SCRIPT_PATHS } from "./system-automations";

type WorkspaceAutomationPath = keyof typeof WORKSPACE_STARTER_AUTOMATION_CONTENT;

type StaticAutomationPath = keyof typeof STATIC_AUTOMATION_CONTENT;
type SystemAutomationPath = keyof typeof SYSTEM_AUTOMATION_CONTENT;

const readWorkspaceAutomation = (path: WorkspaceAutomationPath) => {
  const content = WORKSPACE_STARTER_AUTOMATION_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected workspace automation '${path}'.`);
  }
  return content;
};

const readStaticAutomation = (path: StaticAutomationPath) => {
  const content = STATIC_AUTOMATION_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected static automation '${path}'.`);
  }
  return content;
};

const readSystemAutomation = (path: SystemAutomationPath) => {
  const content = SYSTEM_AUTOMATION_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected system automation '${path}'.`);
  }
  return content;
};

describe("automation content", () => {
  test("runnable workspace codemode scripts use executor-compatible nullary functions", () => {
    const runnableCodemodeScripts = Object.keys(WORKSPACE_STARTER_AUTOMATION_CONTENT).filter(
      (path): path is WorkspaceAutomationPath =>
        path.endsWith(".js") && !path.endsWith(".workflow.js"),
    );

    const scriptsWithInjectedParameterSignatures = runnableCodemodeScripts.filter((path) =>
      /^\s*async\s*\(\s*\{/u.test(readWorkspaceAutomation(path)),
    );

    expect(scriptsWithInjectedParameterSignatures).toEqual([]);
  });

  test("workflow starter scripts use the flat codemode provider APIs", () => {
    const workflow = readWorkspaceAutomation(STARTER_AUTOMATION_SCRIPT_PATHS.telegramUserLinking);
    const unsupportedNestedProviderCalls = Array.from(
      workflow.matchAll(/\b(?:otp|automations)\.identity\.[A-Za-z_$][\w$]*/gu),
      (match) => match[0],
    );

    expect(unsupportedNestedProviderCalls).toEqual([]);
    expect(workflow).toContain("identity.resolveExternal(");
    expect(workflow).toContain("otp.createIdentityClaim(");
    expect(workflow).toContain("telegram/claim-workflow/");
    expect(workflow).not.toContain('key: "telegram/" + chatId');
    expect(workflow).toContain("claim.url");
    expect(workflow).toContain("claim.otpId");
    expect(workflow).toContain("Open this link to finish linking your Telegram account:");
    expect(workflow).toContain("completedEvent.subject.userId");
    expect(workflow).toContain("completedOtpId !== claim.otpId");
    expect(workflow).toContain("store.set(");
    expect(workflow).not.toContain("automationEvent.actors.principal");
    expect(workflow).not.toContain("bind telegram user");
  });

  test("DB starter routes start user-editable workflows", () => {
    const routes = STARTER_AUTOMATION_ROUTES;
    const identityClaimCompleted = AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted;

    expect(identityClaimCompleted).toBe("identity.claim.completed");
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trigger: expect.objectContaining({
            source: "telegram",
            eventType: "message.received",
          }),
          action: expect.objectContaining({
            workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
          }),
        }),
        expect.objectContaining({
          trigger: expect.objectContaining({
            source: "telegram",
            eventType: "message.received",
          }),
          action: expect.objectContaining({
            workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
          }),
        }),
        expect.objectContaining({
          trigger: expect.objectContaining({
            source: "otp",
            eventType: "identity.claim.completed",
          }),
          action: expect.objectContaining({
            kind: "send_workflow_event",
            target: {
              kind: "stored_instance_id",
              keyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
            },
            eventType: "identity-claim-completed",
          }),
        }),
      ]),
    );
  });

  test("automation content separates static and system workflows", () => {
    expect(Object.keys(STATIC_AUTOMATION_CONTENT).sort()).toEqual(
      [STATIC_AUTOMATION_SCRIPT_PATHS.projectFilesConfigure].sort(),
    );
    expect(Object.keys(SYSTEM_AUTOMATION_CONTENT).sort()).toEqual(
      [SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization].sort(),
    );
  });

  test("starter routes start system workflows in their owning automation scope", () => {
    expect(SYSTEM_STARTER_AUTOMATION_ROUTES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "system-workspace-file-initialization",
          trigger: expect.objectContaining({
            source: "auth",
            eventType: "organization.created",
          }),
          action: expect.objectContaining({
            workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
          }),
        }),
      ]),
    );
    expect(STARTER_AUTOMATION_ROUTES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "system-project-files-configure",
          trigger: expect.objectContaining({
            source: "automations",
            eventType: "project.created",
          }),
          action: expect.objectContaining({
            workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
          }),
        }),
      ]),
    );
  });

  test("organization creation workflow configures upload database connection", () => {
    const workflow = readSystemAutomation(
      SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization,
    );

    expect(workflow).toContain('{ name: "workspace-file-initialization" }');
    expect(workflow).toContain('automationEvent.eventType !== "organization.created"');
    expect(workflow).toContain("connections.configure({");
    expect(workflow).toContain('id: "upload"');
    expect(workflow).toContain('payload: { provider: "database" }');
  });

  test("project creation workflow configures project files", () => {
    const workflow = readStaticAutomation(STATIC_AUTOMATION_SCRIPT_PATHS.projectFilesConfigure);

    expect(workflow).toContain('{ name: "project-files-configure" }');
    expect(workflow).toContain('automationEvent.eventType !== "project.created"');
    expect(workflow).toContain("internal.projectFilesConfigure({ projectId })");
  });
});
