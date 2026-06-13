import { describe, expect, test } from "vitest";

import { AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import { WORKSPACE_STARTER_AUTOMATION_CONTENT } from "./starter-automations";
import { AUTOMATION_SCRIPT_PATHS, SYSTEM_AUTOMATION_CONTENT } from "./system-automations";

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
    const workflow = readWorkspaceAutomation(AUTOMATION_SCRIPT_PATHS.telegramUserLinking);
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

  test("workspace router starts user-editable workflows and system router starts upload setup", () => {
    const router = readWorkspaceAutomation(AUTOMATION_SCRIPT_PATHS.workspaceRouter);
    const systemRouter = readSystemAutomation(AUTOMATION_SCRIPT_PATHS.systemRouter);
    const identityClaimCompleted = AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted;
    const piCapabilityConfigured = AUTOMATION_SOURCE_EVENT_TYPES.pi.capabilityConfigured;

    expect({
      routerHandlesContractEvent: router.includes(
        `event.eventType === "${identityClaimCompleted}"`,
      ),
      routerUsesEventIdPrefixForStart: router.includes('instanceIdForEvent("telegram-link")'),
      routerStartsTelegramUserLinkingWorkflow:
        router.includes('remoteWorkflowName: "telegram-user-linking"') &&
        router.includes('"/workspace/automations/telegram-user-linking.workflow.js"'),
      routerSendsWorkflowSafeEvent: router.includes('type: "identity-claim-completed"'),
      routerStartsTelegramTestCommandWorkflow:
        router.includes("workflowScriptPath:") &&
        router.includes('"/workspace/automations/telegram-test-command.workflow.js"'),
      routerStartsTelegramUserPiLinkingWorkflow:
        router.includes('remoteWorkflowName: "telegram-user-pi-linking"') &&
        router.includes('"/workspace/automations/telegram-user-pi-linking.workflow.js"'),
      routerHandlesPiConfigured:
        router.includes('event.source === "pi"') &&
        router.includes(`event.eventType === "${piCapabilityConfigured}"`),
      systemRouterStartsWorkspaceFileInitializationWorkflow:
        systemRouter.includes(
          'event.source === "auth" && event.eventType === "organization.created"',
        ) &&
        systemRouter.includes('remoteWorkflowName: "workspace-file-initialization"') &&
        systemRouter.includes('"/system/automations/workspace-file-initialization.workflow.js"'),
      routerStoresDefaultPiAgent:
        router.includes("event.payload.harnesses") &&
        router.includes("event.payload.modelCatalog") &&
        router.includes('key: "pi/pi-default-agent"') &&
        router.includes('value: harness.id + "::" + model.provider + "::" + model.name'),
    }).toEqual({
      routerHandlesContractEvent: true,
      routerUsesEventIdPrefixForStart: true,
      routerStartsTelegramUserLinkingWorkflow: true,
      routerSendsWorkflowSafeEvent: true,
      routerStartsTelegramTestCommandWorkflow: true,
      routerStartsTelegramUserPiLinkingWorkflow: true,
      routerHandlesPiConfigured: true,
      systemRouterStartsWorkspaceFileInitializationWorkflow: true,
      routerStoresDefaultPiAgent: true,
    });
  });

  test("organization creation workflow configures upload database connection", () => {
    const workflow = readSystemAutomation(AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization);

    expect(workflow).toContain('{ name: "workspace-file-initialization" }');
    expect(workflow).toContain('automationEvent.eventType !== "organization.created"');
    expect(workflow).toContain("connections.configure({");
    expect(workflow).toContain('id: "upload"');
    expect(workflow).toContain('payload: { provider: "database" }');
  });
});
