import { assert, expect, test, vi } from "vitest";

import { MODELS_CLASSIFY_IMAGE_LIMITS } from "@fragno-dev/backoffice-api/v0/models";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { base64ToBytes } from "@/lib/base64";

import { BillingObject } from "../../../../workers/billing.do";
import { modelsToolFamily } from "./models";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1" };
const member = createBackofficeUserExecution({ scope, userId: "member-1" });
const period = new Date().toISOString().slice(0, 7);

const triageWorkflow = `export default defineWorkflow({ name: "ticket-triage" }, async (event, step) => {
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
              images: [],
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
          scope,
          period,
          meter: "ai.tokens.input",
          quantity: "1200",
          eventCount: "1",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "models.classifications",
          quantity: "1",
          eventCount: "1",
        }),
        // 1,200 input tokens at $0.10 per million.
        then.billing.tracker({
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
          new (class extends BillingObject {
            override async recordEvent(...args: Parameters<BillingObject["recordEvent"]>) {
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

test("a personal-scope classification is recorded on the user's ledger", async () => {
  const personal: BackofficeContextScope = { kind: "user", userId: "user-1" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "personal classification bills its user",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        classifier: fake.classifier({ answer: triageAnswers, inputTokens: 1_200 }),
      }),
      setup: ({ given }) => [given.auth.user({ id: "user-1" })],
      steps: ({ then }) => [
        then.assert("the call classifies without an organization", async (ctx) => {
          const codemode = await ctx.runCodemode({
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
          });
          expect(codemode.result).toEqual({ answers: triageAnswers() });
          expect(ctx.fakes.classifier?.calls).toHaveLength(1);
        }),
        then.billing.tracker({
          scope: personal,
          period,
          meter: "ai.tokens.input",
          quantity: "1200",
          eventCount: "1",
        }),
      ],
    }),
  );
});

const reviewQuestion = {
  matchesBrief: {
    type: "bool",
    instructions: "Does the image match the brief?",
    criteria: { true: "The image matches", false: "The image does not match" },
  },
} as const;
const reviewAnswers = { matchesBrief: { type: "bool", probability: 0.95 } } as const;
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";

const reviewedImageWorkflow = `export default defineWorkflow({ name: "reviewed-image" }, async (event, step) => {
  const { path } = await step.do("generate image", async () =>
    await models.generateImage({ prompt: event.payload.brief, out: "/workspace/images/review.png" }),
  );
  const { answers } = await step.do("review image", async () =>
    await models.classify({
      state: { brief: event.payload.brief },
      images: [path],
      questions: ${JSON.stringify(reviewQuestion)},
    }),
  );
  return { path, disposition: answers.matchesBrief.probability > 0.9 ? "accepted" : "needs-review" };
});`;

test("a workflow generates an image, judges its bytes through Decisions, and bills both calls", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "review a generated workspace image",
      objects: allLocalObjects,
      files: backofficeFiles.workspaceStarter({
        "automations/reviewed-image.workflow.js": reviewedImageWorkflow,
      }),
      fakes: ({ fake }) => ({
        openaiImages: fake.openaiImages({
          image: base64ToBytes(pngBase64),
          inputTokens: 40,
          outputTokens: 4160,
        }),
        openaiDecisions: fake.openaiDecisions({ answers: reviewAnswers, inputTokens: 1200 }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
        given.auth.user({ id: "member-1" }),
        given.auth.member({ orgId: scope.orgId, userId: "member-1", roles: ["member"] }),
      ],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          path: "/workspace/automations/reviewed-image.workflow.js",
          remoteWorkflowName: "reviewed-image",
          instanceId: "reviewed-image-1",
          execution: member,
          event: { ...ticketOpened, payload: { brief: "A brass desk lamp on white" } },
        }),
        then.workflow.instance({
          remoteWorkflowName: "reviewed-image",
          status: "complete",
          output: { path: "/workspace/images/review.png", disposition: "accepted" },
        }),
        then.files.bytes({
          orgId: scope.orgId,
          path: "/workspace/images/review.png",
          content: base64ToBytes(pngBase64),
        }),
        then.assert(
          "Decisions receives the saved image, not its path as text",
          ({ fakes, kernelActions }) => {
            expect(fakes.openaiImages?.requests).toHaveLength(1);
            expect(fakes.openaiDecisions?.requests).toEqual([
              {
                url: "https://api.openai.com/v1/decisions",
                body: {
                  model: "gpt-6-luna",
                  input: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: JSON.stringify({ brief: "A brass desk lamp on white" }),
                        },
                        { type: "input_image", image_url: `data:image/png;base64,${pngBase64}` },
                      ],
                    },
                  ],
                  questions: [
                    {
                      name: "matchesBrief",
                      type: "predicate",
                      instructions:
                        "Does the image match the brief?\n\nTrue means: The image matches\nFalse means: The image does not match",
                    },
                  ],
                },
              },
            ]);
            expect(kernelActions).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  operation: BACKOFFICE_PERMISSION.upload.read,
                  resource: { path: "/workspace/images/review.png" },
                }),
              ]),
            );
          },
        ),
        then.billing.tracker({
          scope,
          period,
          meter: "models.images",
          quantity: "1",
          eventCount: "1",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "models.classifications",
          quantity: "1",
          eventCount: "1",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "ai.tokens.input",
          quantity: "1240",
          eventCount: "2",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "ai.cost.total",
          quantity: "125120000",
          eventCount: "2",
        }),
      ],
    }),
  );
});

test("image read permission is checked before accessing files without restricting text-only decisions", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "classification and file read authority are independent",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        openaiDecisions: fake.openaiDecisions({ answers: reviewAnswers, inputTokens: 12 }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert(
          "a classifier-only delegate can judge text but cannot read image evidence",
          async (ctx) => {
            const actor = {
              scope: "internal",
              type: "agent",
              id: "text-reviewer",
              role: "assistant",
            } as const;
            const system = createBackofficeSystemExecution(scope);
            const execution = { ...system, actors: { ...system.actors, delegation: [actor] } };
            const kernel = new BackofficeKernel({
              ...ctx.runtime.services,
              authorityResolver: withBackofficeActorCapabilityGrants({
                resolver: ctx.runtime.services.authorityResolver,
                actor,
                grants: [BACKOFFICE_PERMISSION.models.classify],
              }),
            });
            const context = createBackofficeToolContext(
              createRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                execution,
                kernel,
                emitter: { kind: "caller" },
              }),
            );
            const input = { state: { brief: "A lamp" }, questions: reviewQuestion };
            await expect(
              executeBackofficeRuntimeTool(
                modelsToolFamily.tools[0],
                {
                  ...input,
                  images: ["/workspace/missing.png"],
                },
                context,
              ),
            ).rejects.toThrow("upload.read");
            expect(ctx.fakes.openaiDecisions?.requests).toEqual([]);
            await expect(
              executeBackofficeRuntimeTool(modelsToolFamily.tools[0], input, context),
            ).resolves.toEqual({ answers: reviewAnswers });
            expect(ctx.fakes.openaiDecisions?.requests).toHaveLength(1);
            expect(ctx.fakes.openaiDecisions?.requests[0].body).toMatchObject({
              input: JSON.stringify(input.state),
            });
          },
        ),
        then.billing.tracker({
          scope,
          period,
          meter: "models.classifications",
          quantity: "1",
          eventCount: "1",
        }),
      ],
    }),
  );
});

test("invalid image evidence never reaches Decisions and corrected files preserve input order", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "classification validates workspace image evidence before billing",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        openaiDecisions: fake.openaiDecisions({ answers: reviewAnswers, inputTokens: 20 }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert(
          "reject missing files, unsupported content, unsafe paths, and too many images",
          async (ctx) => {
            const execution = createBackofficeSystemExecution(scope);
            const context = createBackofficeToolContext(
              createRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                execution,
                kernel: new BackofficeKernel(ctx.runtime.services),
                emitter: { kind: "caller" },
              }),
            );
            const input = { state: { brief: "A lamp" }, questions: reviewQuestion };
            const classify = (images: string[]) =>
              executeBackofficeRuntimeTool(
                modelsToolFamily.tools[0],
                { ...input, images },
                context,
              );
            assert(context.runtimes.state);
            await context.runtimes.state.writeFile(
              "/workspace/images/disguised.jpg",
              '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            );
            await context.runtimes.state.writeFileBytes(
              "/workspace/images/reference.jpg",
              base64ToBytes(pngBase64),
            );
            await expect(classify(["/workspace/missing.png"])).rejects.toThrow("ENOENT");
            await expect(classify(["/workspace/images/disguised.jpg"])).rejects.toThrow(
              "MODELS_CLASSIFY_INVALID_IMAGE",
            );
            for (const path of [
              "https://example.test/image.png",
              "/static/image.png",
              "/workspace/../static/image.png",
              "/workspace/images/../../secret.png",
            ]) {
              await expect(classify([path])).rejects.toThrow(
                "absolute file paths under /workspace",
              );
            }
            await expect(
              classify(
                Array.from(
                  { length: MODELS_CLASSIFY_IMAGE_LIMITS.count + 1 },
                  () => "/workspace/images/reference.jpg",
                ),
              ),
            ).rejects.toThrow();
            expect(ctx.fakes.openaiDecisions?.requests).toEqual([]);
            const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
            const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
            await context.runtimes.state.writeFileBytes("/workspace/images/disguised.jpg", jpeg);
            await context.runtimes.state.writeFileBytes("/workspace/images/third.webp", webp);
            await expect(
              classify([
                "/workspace/images/disguised.jpg",
                "/workspace/images/reference.jpg",
                "/workspace/images/third.webp",
              ]),
            ).resolves.toEqual({ answers: reviewAnswers });
            expect(ctx.fakes.openaiDecisions?.requests).toHaveLength(1);
            expect(ctx.fakes.openaiDecisions?.requests[0].body).toMatchObject({
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: JSON.stringify(input.state) },
                    { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQSkY=" },
                    { type: "input_image", image_url: `data:image/png;base64,${pngBase64}` },
                    { type: "input_image", image_url: "data:image/webp;base64,UklGRgQAAABXRUJQ" },
                  ],
                },
              ],
            });
            for (const path of [
              "/workspace/images/disguised.jpg",
              "/workspace/images/reference.jpg",
              "/workspace/images/third.webp",
            ]) {
              expect(ctx.kernelActions).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    operation: BACKOFFICE_PERMISSION.upload.read,
                    resource: { path },
                  }),
                ]),
              );
            }
          },
        ),
        then.billing.tracker({
          scope,
          period,
          meter: "models.classifications",
          quantity: "1",
          eventCount: "1",
        }),
      ],
    }),
  );
});

const productShotWorkflow = `export default defineWorkflow({ name: "product-shot" }, async (event, step) =>
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
          scope,
          period,
          meter: "ai.tokens.output",
          quantity: "4160",
          eventCount: "1",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "models.images",
          quantity: "1",
          eventCount: "1",
        }),
        // 40 text input tokens at $5 and 4,160 image output tokens at $30 per million.
        then.billing.tracker({
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
