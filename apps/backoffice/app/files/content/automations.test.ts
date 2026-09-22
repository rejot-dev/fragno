import { describe, expect, test } from "vitest";

import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";

import { WORKSPACE_STARTER_CONTENT } from "./starter";

function requireMarketplaceEntry(slug: string) {
  const entry = getStaticMarketplaceEntry({ slug, version: "1.0.0" });
  if (!entry) {
    throw new Error(`Expected the built-in ${slug} Marketplace entry.`);
  }
  return entry;
}

const githubChannelEntry = requireMarketplaceEntry("github-channel");

function readMarketplaceFile(entry: typeof githubChannelEntry, path: string): string {
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
});
