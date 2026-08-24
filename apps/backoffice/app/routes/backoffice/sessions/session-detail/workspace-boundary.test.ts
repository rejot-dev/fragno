import { describe, expect, test } from "vitest";

import { readFileSync } from "node:fs";

const workspaceFiles = [
  "workspace-context.tsx",
  "workspace-model.ts",
  "workspace-panel.tsx",
  "workspace-projection.ts",
  "workspace-split.tsx",
  "workflow-graph-projection.ts",
];

describe("session workspace dependency boundary", () => {
  test("reuses the automation workflow graph without Cadence or XYFlow imports", () => {
    const sources = workspaceFiles.map((fileName) =>
      readFileSync(new URL(fileName, import.meta.url), "utf8"),
    );
    const combinedSource = sources.join("\n");

    expect(combinedSource).toContain("@/routes/backoffice/automations/script-view/workflow-graph");
    expect(combinedSource).not.toContain("/cadence/");
    expect(combinedSource).not.toContain("@xyflow");
  });

  test("keeps the session workspace within a fixed viewport with independent scroll panes", () => {
    const organizationLayout = readFileSync(
      new URL("../organization-layout.tsx", import.meta.url),
      "utf8",
    );
    const threadSource = readFileSync(new URL("session-thread.tsx", import.meta.url), "utf8");
    const panelSource = readFileSync(new URL("workspace-panel.tsx", import.meta.url), "utf8");
    const graphSource = readFileSync(
      new URL("../../automations/script-view/workflow-graph.tsx", import.meta.url),
      "utf8",
    );

    expect(organizationLayout).toContain("h-[calc(100dvh-6.75rem)]");
    expect(organizationLayout).toContain("sm:h-[calc(100dvh-4rem)]");
    expect(organizationLayout).not.toContain("min-h-[calc(100dvh");
    expect(threadSource).toContain("overflow-y-auto overscroll-contain");
    expect(panelSource).toContain("overflow-auto overscroll-contain");
    expect(graphSource).toContain("overflow-auto overscroll-contain");
  });

  test("defines a replayable drawer entrance and desktop split transition", () => {
    const backofficeCss = readFileSync(
      new URL("../../../../backoffice.css", import.meta.url),
      "utf8",
    );

    expect(backofficeCss).toContain("@keyframes bo-session-workspace-enter");
    expect(backofficeCss).toContain(".bo-session-workspace-drawer");
    expect(backofficeCss).toContain("animation-name: bo-session-workspace-enter");
    expect(backofficeCss).toContain(".bo-session-thread-pane");
    expect(backofficeCss).toContain("transition-property: width");
    expect(backofficeCss).toContain(':root[data-reduced-motion="reduce"]');
    expect(backofficeCss).toContain("animation-duration: 0.01ms");
    expect(backofficeCss).toContain("transition-duration: 0.01ms");
    expect(backofficeCss).not.toContain("transition: all");
  });
});
