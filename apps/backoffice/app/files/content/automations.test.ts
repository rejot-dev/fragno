import { describe, expect, test } from "vitest";

import { AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";

import { STARTER_AUTOMATION_CONTENT, STARTER_AUTOMATION_SCRIPT_PATHS } from "./automations";

type StarterAutomationPath = keyof typeof STARTER_AUTOMATION_CONTENT;

const readStarterAutomation = (path: StarterAutomationPath) => {
  const content = STARTER_AUTOMATION_CONTENT[path];
  if (typeof content !== "string") {
    throw new Error(`Expected starter automation '${path}' to be string content.`);
  }
  return content;
};

describe("starter automation content", () => {
  test("runnable codemode starter scripts use executor-compatible nullary functions", () => {
    const runnableCodemodeScripts = Object.keys(STARTER_AUTOMATION_CONTENT).filter(
      (path): path is StarterAutomationPath =>
        path.endsWith(".js") && !path.endsWith(".workflow.js"),
    );

    const scriptsWithInjectedParameterSignatures = runnableCodemodeScripts.filter((path) =>
      /^\s*async\s*\(\s*\{/u.test(readStarterAutomation(path)),
    );

    expect(scriptsWithInjectedParameterSignatures).toEqual([]);
  });

  test("workflow starter scripts use the flat codemode provider APIs", () => {
    const workflow = readStarterAutomation(STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinking);
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

  test("starter router starts event-id keyed workflows and routes OTP completions by OTP id", () => {
    const router = readStarterAutomation(STARTER_AUTOMATION_SCRIPT_PATHS.router);
    const workflow = readStarterAutomation(STARTER_AUTOMATION_SCRIPT_PATHS.telegramClaimLinking);
    const identityClaimCompleted = AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted;
    const piCapabilityConfigured = AUTOMATION_SOURCE_EVENT_TYPES.pi.capabilityConfigured;

    expect({
      routerHandlesContractEvent: router.includes(
        `event.eventType === "${identityClaimCompleted}"`,
      ),
      routerFiltersTelegramClaims: router.includes('event.actor?.source === "telegram"'),
      routerUsesEventIdPrefixForStart: router.includes('instanceIdForEvent("telegram-link")'),
      routerLooksUpOtpWorkflowBinding: router.includes('key: "telegram/claim-workflow/"'),
      routerSendsWorkflowSafeEvent: router.includes('type: "identity-claim-completed"'),
      workflowWaitsForWorkflowSafeEvent: workflow.includes('type: "identity-claim-completed"'),
      routerStartsDelayedTestWorkflow:
        router.includes("workflowScriptPath:") &&
        router.includes('"/starter/automations/scripts/telegram-delayed-test-reply.workflow.js"'),
      routerStartsPiWorkflow:
        router.includes('remoteWorkflowName: "telegram-pi-session"') &&
        router.includes('"/starter/automations/scripts/telegram-pi-session.workflow.js"'),
      routerHandlesPiConfigured: router.includes(
        `event.source === "pi" && event.eventType === "${piCapabilityConfigured}"`,
      ),
      routerDerivesDefaultPiAgent:
        router.includes("event.payload.harnesses") &&
        router.includes("event.payload.modelCatalog") &&
        router.includes('key: "pi/pi-default-agent"') &&
        router.includes('value: harness.id + "::" + model.provider + "::" + model.name'),
    }).toEqual({
      routerHandlesContractEvent: true,
      routerFiltersTelegramClaims: true,
      routerUsesEventIdPrefixForStart: true,
      routerLooksUpOtpWorkflowBinding: true,
      routerSendsWorkflowSafeEvent: true,
      workflowWaitsForWorkflowSafeEvent: true,
      routerStartsDelayedTestWorkflow: true,
      routerStartsPiWorkflow: true,
      routerHandlesPiConfigured: true,
      routerDerivesDefaultPiAgent: true,
    });
  });
});
