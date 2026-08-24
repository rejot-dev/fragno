import { describe, expect, test, assert } from "vitest";

import {
  ORGANIZATION_STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "@/fragno/automation/content/starter-routing";
import { AUTOMATION_SOURCE_EVENT_TYPES } from "@/fragno/automation/contracts";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";

import { WORKSPACE_STARTER_CONTENT } from "./starter";
import { STATIC_AUTOMATION_CONTENT, STATIC_AUTOMATION_SCRIPT_PATHS } from "./static-automations";
import { SYSTEM_AUTOMATION_CONTENT, SYSTEM_AUTOMATION_SCRIPT_PATHS } from "./system-automations";

function requireMarketplaceEntry(slug: string) {
  const entry = getStaticMarketplaceEntry({ slug, version: "1.0.0" });
  if (!entry) {
    throw new Error(`Expected the built-in ${slug} Marketplace entry.`);
  }
  return entry;
}

const telegramChannelEntry = requireMarketplaceEntry("telegram-channel");
const githubChannelEntry = requireMarketplaceEntry("github-channel");

function readMarketplaceFile(entry: typeof telegramChannelEntry, path: string): string {
  const content = entry.files[path];
  if (typeof content !== "string") {
    throw new Error(`Expected Marketplace file '${path}'.`);
  }
  return content;
}

describe("automation content", () => {
  test("workspace starter content contains no domain automation workflows", () => {
    expect(
      Object.keys(WORKSPACE_STARTER_CONTENT).filter((path) => path.endsWith(".workflow.js")),
    ).toEqual([]);
  });

  test("Telegram Channel contains identity linking and Pi workflows", () => {
    const identityLinkingWorkflow = readMarketplaceFile(
      telegramChannelEntry,
      "automations/telegram-user-linking.workflow.js",
    );
    const piLinkingWorkflow = readMarketplaceFile(
      telegramChannelEntry,
      "automations/telegram-user-pi-linking.workflow.js",
    );
    const installer = readMarketplaceFile(telegramChannelEntry, ".marketplace/install.workflow.js");

    expect(identityLinkingWorkflow).toContain('{ name: "telegram-user-linking" }');
    expect(identityLinkingWorkflow).toContain("identity.resolveExternal(");
    expect(identityLinkingWorkflow).toContain("otp.createIdentityClaim(");
    expect(identityLinkingWorkflow).toContain("telegram/claim-workflow/");
    expect(identityLinkingWorkflow).toContain("claim.url");
    expect(identityLinkingWorkflow).toContain("claim.otpId");
    expect(identityLinkingWorkflow).toContain("completedEvent.subject.userId");
    expect(identityLinkingWorkflow).toContain("completedOtpId !== claim.otpId");
    expect(identityLinkingWorkflow).toContain("store.set(");
    expect(piLinkingWorkflow).toContain('{ name: "telegram-user-pi-linking" }');
    expect(piLinkingWorkflow).toContain("pi.createSession(");
    expect(piLinkingWorkflow).toContain("pi.runTurn(");

    assert(AUTOMATION_SOURCE_EVENT_TYPES.otp.identityClaimCompleted === "identity.claim.completed");
    expect(installer).toContain('id: "telegram-start-linking"');
    expect(installer).toContain('id: "telegram-identity-claim-completed"');
    expect(installer).toContain('id: "telegram-pi-linking"');
    expect(installer).toContain('keyTemplate: "telegram/claim-workflow/${event.payload.otpId}"');
  });

  test("GitHub Channel installs the basic webhook classifications", () => {
    const installer = readMarketplaceFile(githubChannelEntry, ".marketplace/install.workflow.js");

    expect(installer).toContain("`create ${definition.eventType} event definition`");
    expect(installer).toContain("events.catalogGet({");
    expect(installer).toContain("events.catalogCreate(definition)");
    expect(installer).toContain("router.get({ id: route.id })");
    expect(installer).toContain("router.create(route)");
    expect(installer).not.toContain("router.update(");
    expect(installer).toContain('id: "github-issues-opened-reclassify"');
    expect(installer).toContain('eventType: "issues.opened"');
    expect(installer).toContain('id: "github-issue-comment-created-reclassify"');
    expect(installer).toContain('eventType: "issue_comment.created"');
    expect(installer).toContain('id: "github-pull-request-opened-reclassify"');
    expect(installer).toContain('eventType: "pull_request.opened"');
    expect(installer).toContain('id: "github-pull-request-synchronize-reclassify"');
    expect(installer).toContain('eventType: "pull_request.synchronize"');
    expect(installer).toContain('id: "github-push-reclassify"');
    expect(installer).toContain('eventType: "push"');
    expect(installer).toContain('pullRequest: "$.payload.pullRequest"');
  });

  test("core starter routes contain only platform lifecycle behavior", () => {
    expect(ORGANIZATION_STARTER_AUTOMATION_ROUTES.map((route) => route.id)).toEqual([
      "system-project-files-configure",
    ]);
    expect(SYSTEM_STARTER_AUTOMATION_ROUTES.map((route) => route.id)).toEqual([
      "system-workspace-file-initialization",
      "system-auth-organization-created-forward-to-org",
      "system-auth-organization-updated-forward-to-org",
    ]);
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
    expect(ORGANIZATION_STARTER_AUTOMATION_ROUTES).toEqual(
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
    const workflow =
      SYSTEM_AUTOMATION_CONTENT[SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization];

    expect(workflow).toContain('{ name: "workspace-file-initialization" }');
    expect(workflow).toContain('automationEvent.eventType !== "organization.created"');
    expect(workflow).toContain("connections.configure({");
    expect(workflow).toContain('id: "upload"');
    expect(workflow).toContain('payload: { provider: "database" }');
  });

  test("project creation workflow configures project files", () => {
    const workflow =
      STATIC_AUTOMATION_CONTENT[STATIC_AUTOMATION_SCRIPT_PATHS.projectFilesConfigure];

    expect(workflow).toContain('{ name: "project-files-configure" }');
    expect(workflow).toContain('automationEvent.eventType !== "project.created"');
    expect(workflow).toContain("internal.projectFilesConfigure({ projectId })");
  });
});
