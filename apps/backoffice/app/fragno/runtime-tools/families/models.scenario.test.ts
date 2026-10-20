import { assert, expect, test, vi } from "vitest";

import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeUserExecution } from "@/backoffice-runtime/context";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";

import { InMemoryBillingObject } from "../../../../workers/billing.do";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1" };
const member = createBackofficeUserExecution({ scope, userId: "member-1" });
const period = new Date().toISOString().slice(0, 7);

const triageWorkflow = `defineWorkflow({ name: "ticket-triage" }, async (event, step) => {
  const triage = await step.do("classify ticket", async () =>
    await models.classify({
      state: { subject: event.payload.subject, body: event.payload.body },
      questions: {
        department: {
          type: "choice",
          instructions: "Which team should handle this ticket?",
          criteria: { billing: "Payments, invoices, and refunds", technical: "Product problems" },
        },
        urgent: {
          type: "bool",
          instructions: "Does the customer need a reply today?",
          criteria: { true: "The customer is blocked or losing money", false: "It can wait" },
        },
      },
    }),
  );
  const { department, urgent } = triage.answers;
  return { queue: urgent.probability > 0.5 ? department.choice + "-urgent" : department.choice };
});`;

const triageAnswers = () =>
  ({
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.95, technical: 0.05 },
      confidence: 0.9,
    },
    urgent: { type: "bool", probability: 0.8 },
  }) as const;

const ticketOpened = {
  id: "ticket-1",
  scopeRestriction: null,
  scope,
  source: "support",
  eventType: "ticket.opened",
  occurredAt: "2026-10-20T09:00:00.000Z",
  payload: { subject: "Charged twice", body: "I was charged twice for my order." },
  actors: member.actors,
  causation: { kind: "origin" as const },
};

test("a workflow routes a ticket by the classifier's answers and bills its organization", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "ticket triage with models.classify",
      objects: allLocalObjects,
      files: backofficeFiles.workspaceStarter({
        "automations/ticket-triage.workflow.js": triageWorkflow,
      }),
      fakes: ({ fake }) => ({
        classifier: fake.classifier({ answer: triageAnswers, inputTokens: 1_200 }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
        given.auth.user({ id: "member-1" }),
        given.auth.member({ orgId: scope.orgId, userId: "member-1", roles: ["member"] }),
      ],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          path: "/workspace/automations/ticket-triage.workflow.js",
          remoteWorkflowName: "ticket-triage",
          instanceId: "ticket-triage-1",
          execution: member,
          event: ticketOpened,
        }),
        then.workflow.instance({
          remoteWorkflowName: "ticket-triage",
          status: "complete",
          output: { queue: "billing-urgent" },
        }),
        then.assert("the classifier judged the ticket's subject and body", ({ fakes }) => {
          assert(fakes.classifier);
          expect(fakes.classifier.calls).toEqual([
            {
              state: { subject: "Charged twice", body: "I was charged twice for my order." },
              questions: {
                department: {
                  type: "choice",
                  instructions: "Which team should handle this ticket?",
                  criteria: {
                    billing: "Payments, invoices, and refunds",
                    technical: "Product problems",
                  },
                },
                urgent: {
                  type: "bool",
                  instructions: "Does the customer need a reply today?",
                  criteria: {
                    true: "The customer is blocked or losing money",
                    false: "It can wait",
                  },
                },
              },
            },
          ]);
        }),
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "ai.tokens.input",
          quantity: "1200",
          eventCount: "1",
        }),
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "models.classifications",
          quantity: "1",
          eventCount: "1",
        }),
        // 1,200 input tokens at $0.10 per million.
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "ai.cost.total",
          quantity: "120000",
          eventCount: "1",
        }),
      ],
    }),
  );
});

test("usage reaches billing after an outage without classifying again", async () => {
  let unavailableDeliveries = 1;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "classification billing survives a billing outage",
      objects: {
        ...allLocalObjects,
        BILLING: (input) =>
          new (class extends InMemoryBillingObject {
            override async recordEvent(...args: Parameters<InMemoryBillingObject["recordEvent"]>) {
              if (unavailableDeliveries > 0) {
                unavailableDeliveries -= 1;
                throw new Error("Billing is unavailable.");
              }
              return await super.recordEvent(...args);
            }
          })(input),
      },
      files: backofficeFiles.workspaceStarter({
        "automations/ticket-triage.workflow.js": triageWorkflow,
      }),
      fakes: ({ fake }) => ({
        classifier: fake.classifier({ answer: triageAnswers, inputTokens: 1_200 }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          path: "/workspace/automations/ticket-triage.workflow.js",
          remoteWorkflowName: "ticket-triage",
          instanceId: "ticket-triage-1",
          event: ticketOpened,
        }),
        then.workflow.instance({
          remoteWorkflowName: "ticket-triage",
          status: "complete",
          output: { queue: "billing-urgent" },
        }),
        when.time.advance("5 minutes"),
        then.assert("the outage cost one delivery, not a classification", ({ fakes }) => {
          expect(unavailableDeliveries).toBe(0);
          expect(fakes.classifier?.calls).toHaveLength(1);
        }),
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "ai.tokens.input",
          quantity: "1200",
          eventCount: "1",
        }),
      ],
    }),
  );
});

test("a personal-scope classification without a billing organization never reaches the provider", async () => {
  const personal: BackofficeContextScope = { kind: "user", userId: "user-1" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "personal classification requires a billing organization",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        classifier: fake.classifier({ answer: triageAnswers, inputTokens: 1_200 }),
      }),
      setup: ({ given }) => [given.auth.user({ id: "user-1" })],
      steps: ({ then }) => [
        then.assert("the call is rejected before classifying", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope: personal,
              code: `async () => await models.classify({
                state: { text: "hello" },
                questions: {
                  greeting: {
                    type: "bool",
                    instructions: "Is this a greeting?",
                    criteria: { true: "It greets", false: "It does not" },
                  },
                },
              })`,
            }),
          ).rejects.toThrow("MODELS_BILLING_OWNER_REQUIRED");
          expect(ctx.fakes.classifier?.calls).toEqual([]);
        }),
      ],
    }),
  );
});

const productShotWorkflow = `defineWorkflow({ name: "product-shot" }, async (event, step) =>
  await step.do("draw product shot", async () =>
    await models.generateImage({
      prompt: event.payload.prompt,
      out: "/workspace/images/" + event.payload.sku + ".jpg",
      size: "1536x1024",
      quality: "low",
    }),
  ),
);`;

test("a workflow writes a generated image to the workspace and bills its organization", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "product shot with models.generateImage",
      objects: allLocalObjects,
      files: backofficeFiles.workspaceStarter({
        "automations/product-shot.workflow.js": productShotWorkflow,
      }),
      fakes: ({ fake }) => ({
        openaiImages: fake.openaiImages({ image: jpeg, inputTokens: 40, outputTokens: 4_160 }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
        given.auth.user({ id: "member-1" }),
        given.auth.member({ orgId: scope.orgId, userId: "member-1", roles: ["member"] }),
      ],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          path: "/workspace/automations/product-shot.workflow.js",
          remoteWorkflowName: "product-shot",
          instanceId: "product-shot-1",
          execution: member,
          event: {
            ...ticketOpened,
            id: "product-1",
            source: "catalog",
            eventType: "product.created",
            payload: { sku: "lamp-1", prompt: "A brass desk lamp on white, studio light" },
          },
        }),
        then.workflow.instance({
          remoteWorkflowName: "product-shot",
          status: "complete",
          output: { path: "/workspace/images/lamp-1.jpg" },
        }),
        then.assert("the .jpg path asked OpenAI for a JPEG", ({ fakes }) => {
          expect(fakes.openaiImages?.requests).toEqual([
            {
              url: "https://api.openai.com/v1/images/generations",
              body: {
                model: "gpt-image-2.5-flare",
                prompt: "A brass desk lamp on white, studio light",
                n: 1,
                size: "1536x1024",
                quality: "low",
                output_format: "jpeg",
              },
            },
          ]);
        }),
        then.files.bytes({
          orgId: scope.orgId,
          path: "/workspace/images/lamp-1.jpg",
          content: jpeg,
        }),
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "ai.tokens.output",
          quantity: "4160",
          eventCount: "1",
        }),
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "models.images",
          quantity: "1",
          eventCount: "1",
        }),
        // 40 text input tokens at $5 and 4,160 image output tokens at $30 per million.
        then.billing.tracker({
          organizationId: scope.orgId,
          scope,
          period,
          meter: "ai.cost.total",
          quantity: "125000000",
          eventCount: "1",
        }),
      ],
    }),
  );
});
