import { assert, expect, test } from "vitest";

import {
  createWorkflowTokenMachine,
  renderWorkflowGraphText,
  tokenizeWorkflowSource,
} from "./index.ts";
import { WORKFLOW_VISUALIZER_FIXTURES } from "./test-support/workflow-fixtures.ts";

const RESON8_SETUP_WORKFLOW_SOURCE = `defineWorkflow({ name: "reson8-setup" }, async (_event, step) => {
  await step.do("request-reson8-api-key", async () => ({
    $ui: {
      version: 1,
      state: { response: { apiKey: "" } },
      spec: {
        root: "form",
        elements: {
          form: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "description", "apiKey", "submit"],
          },
          heading: {
            type: "Heading",
            props: { text: "Set up Reson8", level: 2 },
            children: [],
          },
          description: {
            type: "Text",
            props: {
              text: "Enter your Reson8 API key to enable speech-to-text transcription. It will be stored securely and is not displayed after submission.",
              tone: "muted",
            },
            children: [],
          },
          apiKey: {
            type: "TextInput",
            props: {
              label: "Reson8 API key",
              value: { $bindState: "/response/apiKey" },
              required: true,
              secret: true,
              placeholder: "Paste your Reson8 API key",
            },
            children: [],
          },
          submit: {
            type: "WorkflowEventButton",
            props: {
              label: "Configure Reson8",
              eventType: "reson8-setup-submitted",
              payload: { $state: "/response" },
              variant: "primary",
            },
            children: [],
          },
        },
      },
    },
  }));

  const submitted = await step.waitForEvent("reson8-setup-submitted", {
    type: "reson8-setup-submitted",
  });

  const configured = await step.do("configure-reson8", async () => {
    return await connections.configure({
      id: "reson8",
      payload: { apiKey: submitted.payload.apiKey },
    });
  });

  const verified = await step.do("verify-reson8", async () => {
    const verification = await connections.verify({ id: "reson8" });
    const finalStatus = await connections.get({ id: "reson8" });
    return { verification, finalStatus };
  });

  const ok = verified.verification.verification?.ok === true || verified.finalStatus.configured === true;
  const message = verified.verification.verification?.message || verified.finalStatus.verification?.message || (ok ? "Reson8 is configured." : "Reson8 setup needs attention.");
  const missing = verified.finalStatus.missing || [];
  const nextSteps = verified.finalStatus.nextSteps || [];

  return {
    configured,
    verification: verified.verification,
    finalStatus: verified.finalStatus,
    $ui: {
      version: 1,
      state: {
        status: ok ? "Configured" : "Needs attention",
        message,
        missing: missing.length ? missing.join(", ") : "None",
        nextSteps: nextSteps.length ? nextSteps.join(" ") : "You can now use Reson8 speech-to-text tools.",
      },
      spec: {
        root: "result",
        elements: {
          result: {
            type: "Stack",
            props: { gap: "md" },
            children: ["heading", "status", "message", "details", "next"],
          },
          heading: {
            type: "Heading",
            props: { text: "Reson8 setup result", level: 2 },
            children: [],
          },
          status: {
            type: "Badge",
            props: { label: { $state: "/status" }, variant: ok ? "live" : "failed" },
            children: [],
          },
          message: {
            type: "Callout",
            props: { title: "Verification", text: { $state: "/message" }, variant: ok ? "live" : "failed" },
            children: [],
          },
          details: {
            type: "KeyValue",
            props: {
              columns: 1,
              items: [
                { key: "missing", label: "Missing fields", value: { $state: "/missing" } },
              ],
            },
            children: [],
          },
          next: {
            type: "Text",
            props: { text: { $state: "/nextSteps" }, tone: "muted" },
            children: [],
          },
        },
      },
    },
  };
});`;

test("renders the Reson8 setup workflow while tokens stream in one-percent batches", () => {
  const tokens = Array.from(tokenizeWorkflowSource(RESON8_SETUP_WORKFLOW_SOURCE));
  const machine = createWorkflowTokenMachine({ path: "reson8-setup.workflow.ts" });
  const visualizations: Array<{ percentage: number; ascii: string }> = [];

  for (let percentage = 1; percentage <= 100; percentage += 1) {
    const start = Math.floor((tokens.length * (percentage - 1)) / 100);
    const end = Math.floor((tokens.length * percentage) / 100);
    machine.pushAll(tokens.slice(start, end));
    visualizations.push({
      percentage,
      ascii: renderWorkflowGraphText(machine.snapshot().graph),
    });
  }

  expect(visualizations).toHaveLength(100);
  expect(visualizations).toMatchInlineSnapshot(`
    [
      {
        "ascii": "workflow reson8-setup [awaiting body]",
        "percentage": 1,
      },
      {
        "ascii": "workflow reson8-setup [body]",
        "percentage": 2,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]",
        "percentage": 3,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 4,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 5,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 6,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 7,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 8,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 9,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 10,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 11,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 12,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 13,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 14,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 15,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 16,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 17,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 18,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 19,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 20,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 21,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 22,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 23,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 24,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 25,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 26,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 27,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 28,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 29,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 30,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 31,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …",
        "percentage": 32,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key [labeled]
       returns: ({ $ui: …, }",
        "percentage": 33,
      },
      {
        "ascii": "workflow reson8-setup [body]
    └─ 0. do request-reson8-api-key
       returns: ({ $ui: …, })",
        "percentage": 34,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    └─ 1. waitForEvent reson8-setup-submitted [labeled]",
        "percentage": 35,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    └─ 1. waitForEvent reson8-setup-submitted
       event: reson8-setup-submitted",
        "percentage": 36,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do [discovered]",
        "percentage": 37,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do configure-reson8 [labeled]",
        "percentage": 38,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do configure-reson8 [labeled]
       returns: await connections.configure({ id",
        "percentage": 39,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do configure-reson8 [labeled]
       returns: await connections.configure({ id: "reson8", payload: { apiKey",
        "percentage": 40,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do configure-reson8 [labeled]
       returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey },",
        "percentage": 41,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    └─ 2. do configure-reson8
       returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })",
        "percentage": 42,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 43,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 44,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 45,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 46,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 47,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]",
        "percentage": 48,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8 [labeled]
       returns: { verification, finalStatus }",
        "percentage": 49,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 50,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 51,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 52,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 53,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 54,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 55,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 56,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 57,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    └─ 3. do verify-reson8
       returns: { verification, finalStatus }",
        "percentage": 58,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured",
        "percentage": 59,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification,",
        "percentage": 60,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 61,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 62,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 63,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 64,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 65,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 66,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 67,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 68,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 69,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 70,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 71,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 72,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 73,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 74,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 75,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 76,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 77,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 78,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 79,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 80,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 81,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 82,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 83,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 84,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 85,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 86,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 87,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 88,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 89,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 90,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 91,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 92,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 93,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 94,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 95,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 96,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 97,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 98,
      },
      {
        "ascii": "workflow reson8-setup [body]
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return [returning]
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …",
        "percentage": 99,
      },
      {
        "ascii": "workflow reson8-setup
    ├─ 0. do request-reson8-api-key
    │  returns: ({ $ui: …, })
    ├─ 1. waitForEvent reson8-setup-submitted
    │  event: reson8-setup-submitted
    ├─ 2. do configure-reson8
    │  returns: await connections.configure({ id: "reson8", payload: { apiKey: submitted.payload.apiKey }, })
    ├─ 3. do verify-reson8
    │  returns: { verification, finalStatus }
    └─ 4. terminal final return
       value: { configured, verification: verified.verification, finalStatus: verified.finalStatus, $ui: …, }",
        "percentage": 100,
      },
    ]
  `);
  assert(visualizations.some(({ ascii }) => ascii.includes("request-reson8-api-key")));
  assert(visualizations.some(({ ascii }) => ascii.includes("reson8-setup-submitted")));

  const finalSnapshot = machine.finish();
  const durableStepLabels = finalSnapshot.graph.nodes
    .filter((node) => node.kind === "step")
    .map((node) => node.label);

  expect(durableStepLabels).toEqual([
    "request-reson8-api-key",
    "reson8-setup-submitted",
    "configure-reson8",
    "verify-reson8",
  ]);
  assert(finalSnapshot.graph.nodes.some((node) => node.kind === "terminal"));
  expect(finalSnapshot.graph.diagnostics).toEqual([]);
  expect(visualizations.at(-1)?.ascii).toContain("workflow reson8-setup");
});

test("renders the Reson8 OGA upload try/catch workflow in one-percent batches", () => {
  const source = new Map(WORKFLOW_VISUALIZER_FIXTURES).get(
    "automations/reson8-transcribe-oga-upload-v2.workflow.js",
  );
  assert(source);
  const tokens = Array.from(tokenizeWorkflowSource(source));
  const machine = createWorkflowTokenMachine({
    path: "automations/reson8-transcribe-oga-upload-v2.workflow.js",
  });
  const visualizations: Array<{ percentage: number; ascii: string }> = [];

  for (let percentage = 1; percentage <= 100; percentage += 1) {
    const start = Math.floor((tokens.length * (percentage - 1)) / 100);
    const end = Math.floor((tokens.length * percentage) / 100);
    machine.pushAll(tokens.slice(start, end));
    visualizations.push({
      percentage,
      ascii: renderWorkflowGraphText(machine.snapshot().graph),
    });
  }

  expect(visualizations).toHaveLength(100);
  expect(visualizations).toMatchInlineSnapshot(`
    [
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [awaiting body]",
        "percentage": 1,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [awaiting body]",
        "percentage": 2,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]",
        "percentage": 3,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]",
        "percentage": 4,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 5,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 6,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 7,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 8,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 9,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 10,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 11,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 12,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 13,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 14,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 15,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 16,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 17,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 18,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 19,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 20,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 21,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 22,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 23,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 24,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 25,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 26,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 27,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 28,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 29,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 30,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 31,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 32,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 33,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 34,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 35,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 36,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 37,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload [labeled]
       returns: ({ $ui: …",
        "percentage": 38,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload
       returns: ({ $ui: …})",
        "percentage": 39,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    └─ 0. do request OGA upload
       returns: ({ $ui: …})",
        "percentage": 40,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    └─ 1. waitForEvent receive OGA upload [labeled]",
        "percentage": 41,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    └─ 1. waitForEvent receive OGA upload
       event: oga-transcribe-submit-v2",
        "percentage": 42,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    └─ 1. waitForEvent receive OGA upload
       event: oga-transcribe-submit-v2",
        "percentage": 43,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    └─ 2. if [condition]",
        "percentage": 44,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    └─ 2. if [condition]",
        "percentage": 45,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    └─ 2. if !file || file.kind !== "prepared-upload" [branches]
       └─ 0. terminal error [throwing]
          value: new Error(",
        "percentage": 46,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]",
        "percentage": 47,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]",
        "percentage": 48,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          └─ 0. do read uploaded audio [labeled]",
        "percentage": 49,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          └─ 0. do read uploaded audio [labeled]
             returns: context.current.upload.readPrepared",
        "percentage": 50,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          └─ 0. do read uploaded audio [labeled]
             returns: context.current.upload.readPrepared({ file, encoding: "bytes"",
        "percentage": 51,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          └─ 0. do read uploaded audio [labeled]
             returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })",
        "percentage": 52,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          └─ 0. do read uploaded audio
             returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })",
        "percentage": 53,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]",
        "percentage": 54,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current",
        "percentage": 55,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current.reson8.transcribePrerecorded({ audio:",
        "percentage": 56,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes:",
        "percentage": 57,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes)",
        "percentage": 58,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true,",
        "percentage": 59,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8 [labeled]
             returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true",
        "percentage": 60,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          └─ 1. do transcribe with Reson8
             returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })",
        "percentage": 61,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          └─ 2. do [discovered]",
        "percentage": 62,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          └─ 2. do commit uploaded audio [labeled]",
        "percentage": 63,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          └─ 2. do commit uploaded audio [labeled]
             returns: context.current.upload.commitPrepared({",
        "percentage": 64,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          └─ 2. do commit uploaded audio
             returns: context.current.upload.commitPrepared({ file })",
        "percentage": 65,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename",
        "percentage": 66,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 67,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 68,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 69,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 70,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 71,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 72,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 73,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 74,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 75,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 76,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 77,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 78,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 79,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 80,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 81,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 82,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 83,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 84,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 85,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 86,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 87,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 88,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 89,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 90,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 91,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 92,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return [returning]
             value: { filename: file.filename, transcription, saved, $ui: …",
        "percentage": 93,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try [body]
       └─ try [body]
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return
             value: { filename: file.filename, transcription, saved, $ui: …}",
        "percentage": 94,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch [handler]
       └─ try
          ├─ 0. do read uploaded audio
          │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
          ├─ 1. do transcribe with Reson8
          │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
          ├─ 2. do commit uploaded audio
          │  returns: context.current.upload.commitPrepared({ file })
          └─ 3. terminal final return
             value: { filename: file.filename, transcription, saved, $ui: …}",
        "percentage": 95,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch [handler]
       ├─ try
       │  ├─ 0. do read uploaded audio
       │  │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
       │  ├─ 1. do transcribe with Reson8
       │  │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
       │  ├─ 2. do commit uploaded audio
       │  │  returns: context.current.upload.commitPrepared({ file })
       │  └─ 3. terminal final return
       │     value: { filename: file.filename, transcription, saved, $ui: …}
       └─ catch [body]
          └─ 0. do discard failed upload [labeled]",
        "percentage": 96,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch [handler]
       ├─ try
       │  ├─ 0. do read uploaded audio
       │  │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
       │  ├─ 1. do transcribe with Reson8
       │  │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
       │  ├─ 2. do commit uploaded audio
       │  │  returns: context.current.upload.commitPrepared({ file })
       │  └─ 3. terminal final return
       │     value: { filename: file.filename, transcription, saved, $ui: …}
       └─ catch [body]
          └─ 0. do discard failed upload [labeled]
             returns: context",
        "percentage": 97,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch [handler]
       ├─ try
       │  ├─ 0. do read uploaded audio
       │  │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
       │  ├─ 1. do transcribe with Reson8
       │  │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
       │  ├─ 2. do commit uploaded audio
       │  │  returns: context.current.upload.commitPrepared({ file })
       │  └─ 3. terminal final return
       │     value: { filename: file.filename, transcription, saved, $ui: …}
       └─ catch [body]
          └─ 0. do discard failed upload [labeled]
             returns: context.current.upload.discardPrepared({",
        "percentage": 98,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2 [body]
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch [handler]
       ├─ try
       │  ├─ 0. do read uploaded audio
       │  │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
       │  ├─ 1. do transcribe with Reson8
       │  │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
       │  ├─ 2. do commit uploaded audio
       │  │  returns: context.current.upload.commitPrepared({ file })
       │  └─ 3. terminal final return
       │     value: { filename: file.filename, transcription, saved, $ui: …}
       └─ catch [body]
          ├─ 0. do discard failed upload
          │  returns: context.current.upload.discardPrepared({ file })
          └─ 1. terminal error [throwing]",
        "percentage": 99,
      },
      {
        "ascii": "workflow reson8-transcribe-oga-upload-v2
    ├─ 0. do request OGA upload
    │  returns: ({ $ui: …})
    ├─ 1. waitForEvent receive OGA upload
    │  event: oga-transcribe-submit-v2
    ├─ 2. if !file || file.kind !== "prepared-upload"
    │  └─ 0. terminal error Please upload an OGA file.
    │     value: new Error("Please upload an OGA file.")
    └─ 3. try/catch
       ├─ try
       │  ├─ 0. do read uploaded audio
       │  │  returns: context.current.upload.readPrepared({ file, encoding: "bytes", maxBytes: 52428800 })
       │  ├─ 1. do transcribe with Reson8
       │  │  returns: context.current.reson8.transcribePrerecorded({ audio: { kind: "bytes", bytes: Array.from(audio.bytes) }, includeTimestamps: true, includeWords: true, includeConfidence: true })
       │  ├─ 2. do commit uploaded audio
       │  │  returns: context.current.upload.commitPrepared({ file })
       │  └─ 3. terminal final return
       │     value: { filename: file.filename, transcription, saved, $ui: …}
       └─ catch
          ├─ 0. do discard failed upload
          │  returns: context.current.upload.discardPrepared({ file })
          └─ 1. terminal error rethrow error
             value: error",
        "percentage": 100,
      },
    ]
  `);

  const finalSnapshot = machine.finish();
  const tryNode = finalSnapshot.graph.nodes.find((node) => node.kind === "try");
  assert(tryNode?.kind === "try");
  expect(tryNode).toMatchObject({
    label: "try/catch",
    hasCatch: true,
    hasFinally: false,
    construction: { status: "complete", phase: "complete" },
  });
  expect(
    finalSnapshot.graph.nodes
      .filter((node) => node.kind === "branch" && node.parentId === tryNode.id)
      .map((node) => node.kind === "branch" && node.branchType),
  ).toEqual(["try", "catch"]);
  expect(finalSnapshot.graph.diagnostics).toEqual([]);
});
