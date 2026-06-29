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
import { SYSTEM_AUTOMATION_CONTENT, SYSTEM_AUTOMATION_SCRIPT_PATHS } from "./system-automations";

type WorkspaceAutomationPath = keyof typeof WORKSPACE_STARTER_AUTOMATION_CONTENT;

type SystemAutomationPath = keyof typeof SYSTEM_AUTOMATION_CONTENT;

const readWorkspaceAutomation = (path: WorkspaceAutomationPath) => {
  const content = WORKSPACE_STARTER_AUTOMATION_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected workspace automation '${path}'.`);
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
    expect(workflow).toContain("otp.createIdentityClaim(");
    expect(workflow).toContain("store.get(");
    expect(workflow).toContain("claim.url");
    expect(workflow).toContain("claim.otpId");
    expect(workflow).toContain("Open this link to finish linking your Telegram account:");
    expect(workflow).toContain("completedEvent.subject.userId");
    expect(workflow).toContain("completedOtpId !== claim.otpId");
    expect(workflow).toContain("store.set(");
  });

  test("DB starter routes start user-editable workflows", () => {
    const routes = STARTER_AUTOMATION_ROUTES;
    const identityClaimCompleted = AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted;
    const piCapabilityConfigured = AUTOMATION_SOURCE_EVENT_TYPES.pi.capabilityConfigured;

    expect(identityClaimCompleted).toBe("identity.claim.completed");
    expect(piCapabilityConfigured).toBe("capability.configured");
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "telegram",
          eventType: "message.received",
          action: expect.objectContaining({
            remoteWorkflowName: "telegram-user-linking",
            workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
          }),
        }),
        expect.objectContaining({
          source: "telegram",
          eventType: "message.received",
          action: expect.objectContaining({
            remoteWorkflowName: "telegram-test-command",
            workflowScriptPath: "/workspace/automations/telegram-test-command.workflow.js",
          }),
        }),
        expect.objectContaining({
          source: "telegram",
          eventType: "message.received",
          action: expect.objectContaining({
            remoteWorkflowName: "telegram-user-pi-linking",
            workflowScriptPath: "/workspace/automations/telegram-user-pi-linking.workflow.js",
          }),
        }),
        expect.objectContaining({
          source: "otp",
          eventType: "identity.claim.completed",
          action: expect.objectContaining({
            kind: "send_workflow_event",
            target: {
              kind: "stored_instance_id",
              keyTemplate: "telegram/claim-workflow/${event.payload.otpId}",
            },
            eventType: "identity-claim-completed",
          }),
        }),
        expect.objectContaining({
          source: "pi",
          eventType: "capability.configured",
          action: expect.objectContaining({
            remoteWorkflowName: "pi-default-agent-configure",
            workflowScriptPath: "/workspace/automations/pi-default-agent-configure.workflow.js",
          }),
        }),
      ]),
    );
  });

  test("system automation content includes built-in system workflows", () => {
    expect(Object.keys(SYSTEM_AUTOMATION_CONTENT).sort()).toEqual(
      [
        SYSTEM_AUTOMATION_SCRIPT_PATHS.codemodeTypesRefresh,
        SYSTEM_AUTOMATION_SCRIPT_PATHS.projectFilesConfigure,
        SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization,
      ].sort(),
    );
  });

  test("starter routes start system workflows in their owning automation scope", () => {
    expect(SYSTEM_STARTER_AUTOMATION_ROUTES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "system-workspace-file-initialization",
          source: "auth",
          eventType: "organization.created",
          action: expect.objectContaining({
            remoteWorkflowName: "workspace-file-initialization",
            workflowScriptPath: "/system/automations/workspace-file-initialization.workflow.js",
          }),
        }),
      ]),
    );
    expect(STARTER_AUTOMATION_ROUTES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "system-project-files-configure",
          source: "automations",
          eventType: "project.created",
          action: expect.objectContaining({
            remoteWorkflowName: "project-files-configure",
            workflowScriptPath: "/system/automations/project-files-configure.workflow.js",
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
    const workflow = readSystemAutomation(SYSTEM_AUTOMATION_SCRIPT_PATHS.projectFilesConfigure);

    expect(workflow).toContain('{ name: "project-files-configure" }');
    expect(workflow).toContain('automationEvent.eventType !== "project.created"');
    expect(workflow).toContain("internal.projectFilesConfigure({ projectId })");
  });

  test("Pi capability workflow stores the default agent", () => {
    const workflow = readWorkspaceAutomation(
      STARTER_AUTOMATION_SCRIPT_PATHS.piDefaultAgentConfigure,
    );

    expect(workflow).toContain('{ name: "pi-default-agent-configure" }');
    expect(workflow).toContain('automationEvent.eventType !== "capability.configured"');
    expect(workflow).toContain('key: "pi/pi-default-agent"');
    expect(workflow).toContain('category: ["pi"]');
  });
});
