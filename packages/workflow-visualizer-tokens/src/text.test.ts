import { expect, test } from "vitest";

import { visualizeWorkflowSource } from "./index.ts";
import { loadBackofficeAutomationFixtures } from "./test-support/backoffice-automation-fixtures.ts";
import {
  renderWorkflowGraphText,
  renderWorkflowMachineDebugText,
  renderWorkflowVisualizationText,
} from "./text.ts";

test("renders the Backoffice automation fixtures for quick inspection", async () => {
  const rendered = (await loadBackofficeAutomationFixtures())
    .map(([path, source]) => {
      const snapshot = visualizeWorkflowSource(path, source);
      return `--- ${path} ---\n${renderWorkflowGraphText(snapshot.graph)}`;
    })
    .join("\n\n");

  expect(rendered).toMatchInlineSnapshot(`
    "--- automations/telegram-user-linking.workflow.js ---
    workflow telegram-user-linking
    ├─ 0. if automationEvent.source !== "telegram" || automationEvent.eventType !== "message.received" || automationEvent.payload.text !== "/start"
    │  └─ 0. terminal early return not-telegram-start
    │     value: { skipped: true, reason: "not-telegram-start" }
    ├─ 1. do lookup existing telegram user link
    │  returns: await store.get({ key: "telegram/" + chatId, })
    ├─ 2. if linkedUser?.value
    │  ├─ 0. do send already linked telegram message
    │  └─ 1. terminal early return
    │     value: { linked: true, alreadyLinked: true, userId: linkedUser.value, }
    ├─ 3. do create telegram identity claim
    │  returns: await otp.createIdentityClaim({ actor: { scope: "external", source: "telegram", type: "chat", id: chatId, }, })
    ├─ 4. do store telegram claim workflow binding
    ├─ 5. do send telegram identity claim link
    ├─ 6. waitForEvent identity-claim-completed
    │  event: identity-claim-completed
    │  timeout: 15 minutes
    ├─ 7. if completedOtpId !== claim.otpId
    │  └─ 0. terminal early return claim-mismatch
    │     value: { linked: false, reason: "claim-mismatch" }
    ├─ 8. if completedActor.source !== "telegram"
    │  └─ 0. terminal early return not-telegram
    │     value: { linked: false, reason: "not-telegram" }
    ├─ 9. do bind telegram user
    ├─ 10. do send telegram user linked message
    └─ 11. terminal final return
       value: { linked: true, userId: subjectUserId, otpId: claim.otpId }

    --- automations/telegram-user-pi-linking.workflow.js ---
    workflow telegram-user-pi-linking
    ├─ 0. if automationEvent.source !== "telegram" || automationEvent.eventType !== "message.received" || (text !== "/pi" && text.startsWith("/"))
    │  └─ 0. terminal early return not-telegram-pi-message
    │     value: { skipped: true, reason: "not-telegram-pi-message" }
    ├─ 1. do lookup linked telegram user
    │  returns: await store.get({ key: "telegram/" + automationActorId, })
    ├─ 2. if !linkedUser
    │  └─ 0. terminal early return telegram-chat-not-linked
    │     value: { skipped: true, reason: "telegram-chat-not-linked" }
    ├─ 3. do lookup default pi agent
    │  returns: await store.get({ key: "pi/pi-default-agent", })
    ├─ 4. if !defaultAgent
    │  └─ 0. terminal early return missing-default-agent
    │     value: { skipped: true, reason: "missing-default-agent" }
    ├─ 5. do lookup pi session
    │  returns: await store.get({ key: "telegram-pi-session/" + linkedUser, })
    ├─ 6. do check existing pi session
    │  return 1: { reusable: false, sessionId: "" }
    │  return 2: { reusable: false, sessionId: "" }
    │  return 3: { reusable: true, sessionId }
    │  return 4: { reusable: false, sessionId: "" }
    ├─ 7. if !reusableSession.reusable
    │  ├─ 0. do create pi session
    │  │  returns: await pi.createSession({ agent: defaultAgent, name: "Telegram " + chatId, tags: ["telegram", "auto-session"], systemMessage: "IMPORTANT:ALL non-tool call output will AUTOMATICALLY be " + "forwarded to Telegram in Markdown parse mode.", })
    │  └─ 1. do store pi session binding
    ├─ 8. do reply to pi command if needed
    │  return 1: { sent: false }
    │  return 2: { sent: true }
    ├─ 9. if commandReply.sent || !text
    │  └─ 0. terminal early return
    │     value: { sessionId: piSession.sessionId }
    ├─ 10. do send telegram typing action
    ├─ 11. do run pi turn
    │  returns: resp.assistantText
    ├─ 12. do send pi response if needed
    │  return 1: { sent: false }
    │  return 2: { sent: true }
    └─ 13. terminal final return
       value: { sessionId: piSession.sessionId }

    --- automations/pi-default-agent-configure.workflow.js ---
    workflow pi-default-agent-configure
    ├─ 0. if automationEvent.source !== "pi" || automationEvent.eventType !== "capability.configured"
    │  └─ 0. terminal early return not-pi-capability-configured
    │     value: { skipped: true, reason: "not-pi-capability-configured" }
    ├─ 1. if typeof harnessId !== "string" || typeof modelProvider !== "string" || typeof modelName !== "string"
    │  └─ 0. terminal early return missing-pi-default-agent-parts
    │     value: { skipped: true, reason: "missing-pi-default-agent-parts" }
    ├─ 2. do store default pi agent
    └─ 3. terminal final return
       value: { stored: true, value }

    --- automations/telegram-test-command.workflow.js ---
    workflow telegram-test-command
    ├─ 0. if text !== "/test"
    │  └─ 0. terminal early return not-test-command
    │     value: { skipped: true, reason: "not-test-command" }
    ├─ 1. sleep wait 3 seconds
    │  duration: 3 seconds
    ├─ 2. do send delayed test reply
    └─ 3. terminal final return
       value: { sent: true }

    --- automations/project-files-configure.workflow.js ---
    workflow project-files-configure
    ├─ 0. if automationEvent.source !== "automations" || automationEvent.eventType !== "project.created"
    │  └─ 0. terminal early return not-project-created
    │     value: { skipped: true, reason: "not-project-created" }
    ├─ 1. if !projectId
    │  └─ 0. terminal error project.created event is missing subject.projectId.
    │     value: new Error("project.created event is missing subject.projectId.")
    ├─ 2. do configure project database filesystem
    │  returns: await internal.projectFilesConfigure({ projectId })
    └─ 3. terminal final return

    --- automations/workspace-file-initialization.workflow.js ---
    workflow workspace-file-initialization
    ├─ 0. if automationEvent.source !== "auth" || automationEvent.eventType !== "organization.created"
    │  └─ 0. terminal early return not-organization-created
    │     value: { skipped: true, reason: "not-organization-created" }
    ├─ 1. if !orgId
    │  └─ 0. terminal error organization.created event is missing subject.orgId.
    │     value: new Error("organization.created event is missing subject.orgId.")
    ├─ 2. do configure upload database connection
    │  returns: { configured: true, id: "upload", provider: "database" }
    ├─ 3. do seed workspace starter files
    │  returns: await org.internal.filesSeedExecute({})
    ├─ 4. do seed starter automation routes
    │  returns: await org.internal.automationsRoutesSeedStarter({})
    └─ 5. terminal final return
       value: { ...configured, seeded, automationRoutes }"
  `);
});

test("renders partial construction and active submachine state", () => {
  const snapshot = visualizeWorkflowSource(
    "automations/partial.workflow.js",
    `defineWorkflow({ name: "partial" }, async (event, step) => {
      if (event.payload.enabled) {
        await step.waitForEvent("approval", { type: "approved",
    `,
    { finish: false },
  );

  expect(renderWorkflowVisualizationText(snapshot)).toMatchInlineSnapshot(`
    "workflow partial [body]
    └─ 0. if event.payload.enabled [branches]
       └─ 0. waitForEvent approval [labeled]
          event: approved"
  `);
  expect(renderWorkflowMachineDebugText(snapshot)).toMatchInlineSnapshot(`
    "state tokenizing · 57 tokens · 164 chars · depth (2/3/0)
    active
      workflow workflow-source:automations/partial.workflow.js#0 [body]
      condition workflow-source:automations/partial.workflow.js#0/condition#0 [consequent] < workflow-source:automations/partial.workflow.js#0
      step workflow-source:automations/partial.workflow.js#0/step#2 [labeled] < workflow-source:automations/partial.workflow.js#0/condition#0"
  `);
});
