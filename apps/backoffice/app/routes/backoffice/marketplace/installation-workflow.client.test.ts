import { assert, describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AutomationWorkflowRun } from "@/routes/backoffice/automations/script-view/workflow-run-presentation";

import {
  selectMarketplaceInstallationGeneratedUi,
  shouldShowMarketplaceInstallationStatus,
} from "./installation-workflow-presentation";
import { MarketplaceInstallerGeneratedUi } from "./installation-workflow.client";

const generatedUi = (label: string) => ({
  $ui: {
    version: 1 as const,
    state: { label },
    spec: {
      root: "text",
      elements: {
        text: {
          type: "Text",
          props: { text: { $state: "/label" } },
          children: [],
        },
      },
    },
  },
});

const workflowRun = (input: Partial<AutomationWorkflowRun> = {}): AutomationWorkflowRun => ({
  id: "run-1",
  instanceId: "installation-1",
  workflowName: "codemode-script",
  remoteWorkflowName: "install-example",
  status: "waiting",
  workflowScriptPath: ".marketplace/install.workflow.js",
  output: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:01.000Z",
  workflowSteps: [],
  workflowEvents: [],
  workflowStepEmissions: [],
  ...input,
});

describe("Marketplace installation status visibility", () => {
  test("surfaces synchronization failures without a local installation request", () => {
    assert(
      shouldShowMarketplaceInstallationStatus({
        requested: false,
        synchronizationFailed: true,
        ingestionStatus: null,
        installerStatus: null,
      }),
    );
  });

  test.each(["errored", "terminated"] as const)(
    "keeps an externally started installation visible after it becomes %s",
    (ingestionStatus) => {
      assert(
        shouldShowMarketplaceInstallationStatus({
          requested: false,
          synchronizationFailed: false,
          ingestionStatus,
          installerStatus: "complete",
        }),
      );
    },
  );

  test("hides a previously completed external installation", () => {
    assert(
      !shouldShowMarketplaceInstallationStatus({
        requested: false,
        synchronizationFailed: false,
        ingestionStatus: "complete",
        installerStatus: "complete",
      }),
    );
  });
});

describe("Marketplace installation generated UI selection", () => {
  test("selects the newest generated UI step", () => {
    const first = generatedUi("First");
    const second = generatedUi("Second");
    const result = selectMarketplaceInstallationGeneratedUi(
      workflowRun({
        workflowSteps: [
          {
            id: "step-1",
            stepKey: "do:first",
            parentStepKey: null,
            name: "first",
            type: "do",
            status: "completed",
            committedByExecutionId: "execution-1",
            attempts: 1,
            waitEventType: null,
            result: first,
            errorName: null,
            errorMessage: null,
            createdAt: "2026-08-11T10:00:00.000Z",
            updatedAt: "2026-08-11T10:00:01.000Z",
          },
          {
            id: "step-2",
            stepKey: "do:second",
            parentStepKey: null,
            name: "second",
            type: "do",
            status: "completed",
            committedByExecutionId: "execution-2",
            attempts: 1,
            waitEventType: null,
            result: second,
            errorName: null,
            errorMessage: null,
            createdAt: "2026-08-11T10:00:02.000Z",
            updatedAt: "2026-08-11T10:00:03.000Z",
          },
        ],
      }),
    );

    expect(result).toEqual({
      kind: "step",
      step: expect.objectContaining({ result: second }),
    });
  });

  test("prefers generated final output after completion", () => {
    const output = generatedUi("Complete");

    expect(
      selectMarketplaceInstallationGeneratedUi(workflowRun({ status: "complete", output })),
    ).toEqual({ kind: "output", value: output });
  });

  test("renders generated final output after completion", () => {
    const markup = renderToStaticMarkup(
      createElement(MarketplaceInstallerGeneratedUi, {
        collectionSource: {
          resolvedScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
          adapterIdentity: "adapter-1",
        },
        instance: workflowRun({ status: "complete", output: generatedUi("Complete") }),
        targetScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      }),
    );

    expect(markup).toContain("Complete");
    expect(markup).not.toContain("Installation complete.");
  });

  test("renders completion in the main installation content without generated output", () => {
    const markup = renderToStaticMarkup(
      createElement(MarketplaceInstallerGeneratedUi, {
        collectionSource: {
          resolvedScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
          adapterIdentity: "adapter-1",
        },
        instance: workflowRun({ status: "complete", output: { installed: true } }),
        targetScope: { kind: "org", organization: { id: "org-1", slug: "acme" } },
      }),
    );

    expect(markup).toContain("Installation complete.");
  });

  test("ignores ordinary workflow values", () => {
    expect(
      selectMarketplaceInstallationGeneratedUi(workflowRun({ output: { installed: true } })),
    ).toBeNull();
  });
});
