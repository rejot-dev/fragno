import { assert, expect, test, vi } from "vitest";

import { MODELS_CLASSIFY_IMAGE_LIMITS } from "@fragno-dev/backoffice-api/v0/models";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { STATE_FILE_MAX_BYTES } from "@fragno-dev/backoffice-api/v0/state";

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
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createFakeR2, requestFromOutside, type FakeR2 } from "@/fragno/blobs-r2.test-utils";
import { blobsR2BucketsFromEnv } from "@/fragno/blobs-server";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { base64ToBytes } from "@/lib/base64";

import { BillingObject } from "../../../../workers/billing-object";
import { BlobsObject } from "../../../../workers/blobs-object";
import { modelsToolFamily } from "./models";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1", jurisdiction: null };
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
  const personal: BackofficeContextScope = { kind: "user", userId: "user-1", jurisdiction: null };
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
      images: [{ path }],
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
                  images: [{ path: "/workspace/missing.png" }],
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
            const classify = (paths: string[]) =>
              executeBackofficeRuntimeTool(
                modelsToolFamily.tools[0],
                { ...input, images: paths.map((path) => ({ path })) },
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

const invoiceSchema = {
  type: "object",
  properties: {
    supplier: { type: "string" },
    invoiceNumber: { type: "string" },
    total: { type: "number" },
    lines: {
      type: "array",
      items: { type: "object", properties: { amount: { type: ["number", "null"] } } },
    },
  },
} as const;
// ASCII, so the scenario writes it as text and the model receives the same bytes.
const invoicePdf = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n";

const bookInvoiceWorkflow = `export default defineWorkflow({ name: "book-invoice" }, async (event, step) => {
  const { output } = await step.do("read invoice", async () =>
    await models.extract({
      files: [{ path: event.payload.path }],
      instructions: "Read the supplier, invoice number, and total of this invoice.",
      schema: ${JSON.stringify(invoiceSchema)},
    }),
  );
  return { supplier: output.supplier, total: output.total };
});`;

test("a workflow reads an invoice PDF into typed fields and bills the extraction", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "extract an invoice with models.extract",
      objects: allLocalObjects,
      files: backofficeFiles.workspaceStarter({
        "automations/book-invoice.workflow.js": bookInvoiceWorkflow,
      }),
      fakes: ({ fake }) => ({
        openaiResponses: fake.openaiResponses({
          output: { supplier: "Brass & Co", invoiceNumber: "2026-114", total: 1250.5 },
          inputTokens: 3000,
          outputTokens: 200,
        }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, name: "Ada Labs" }),
        given.auth.user({ id: "member-1" }),
        given.auth.member({ orgId: scope.orgId, userId: "member-1", roles: ["member"] }),
        given.codemode.writeFile({
          orgId: scope.orgId,
          path: "/workspace/inbox/invoice-2026-114.pdf",
          content: invoicePdf,
        }),
        given.codemode.writeFile({
          orgId: scope.orgId,
          path: "/workspace/inbox/notes.txt",
          content: "Pay before the end of the month.",
        }),
      ],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: scope.orgId,
          path: "/workspace/automations/book-invoice.workflow.js",
          remoteWorkflowName: "book-invoice",
          instanceId: "book-invoice-1",
          execution: member,
          event: { ...ticketOpened, payload: { path: "/workspace/inbox/invoice-2026-114.pdf" } },
        }),
        then.workflow.instance({
          remoteWorkflowName: "book-invoice",
          status: "complete",
          output: { supplier: "Brass & Co", total: 1250.5 },
        }),
        then.assert(
          "the model reads the PDF's bytes and answers in the schema, closed for strict output",
          ({ fakes, kernelActions }) => {
            expect(fakes.openaiResponses?.requests).toEqual([
              {
                url: "https://api.openai.com/v1/responses",
                body: {
                  model: "gpt-6-luna",
                  store: false,
                  reasoning: { effort: "low" },
                  input: [
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_file",
                          filename: "invoice-2026-114.pdf",
                          file_data: `data:application/pdf;base64,${btoa(invoicePdf)}`,
                        },
                        {
                          type: "input_text",
                          text: "Read the supplier, invoice number, and total of this invoice.",
                        },
                      ],
                    },
                  ],
                  text: {
                    format: {
                      type: "json_schema",
                      name: "answer",
                      schema: {
                        type: "object",
                        properties: {
                          supplier: { type: "string" },
                          invoiceNumber: { type: "string" },
                          total: { type: "number" },
                          lines: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: { amount: { type: ["number", "null"] } },
                              required: ["amount"],
                              additionalProperties: false,
                            },
                          },
                        },
                        required: ["supplier", "invoiceNumber", "total", "lines"],
                        additionalProperties: false,
                      },
                      strict: true,
                    },
                  },
                },
              },
            ]);
            expect(kernelActions).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  operation: BACKOFFICE_PERMISSION.upload.read,
                  resource: { path: "/workspace/inbox/invoice-2026-114.pdf" },
                }),
              ]),
            );
          },
        ),
        then.assert("a caller picks the stronger model and more thinking", async (ctx) => {
          await ctx.runCodemode({
            scope,
            code: `async () => await models.extract({
              files: [{ path: "/workspace/inbox/invoice-2026-114.pdf" }],
              instructions: "Read the supplier, invoice number, and total of this invoice.",
              schema: ${JSON.stringify(invoiceSchema)},
              model: "openai/gpt-6.1-sol",
              thinkingLevel: "high",
            })`,
          });
          expect(ctx.fakes.openaiResponses?.requests.at(-1)?.body).toMatchObject({
            model: "gpt-6.1-sol",
            reasoning: { effort: "high" },
          });
        }),
        then.assert(
          "a file that is neither a PDF nor an image never reaches the model",
          async (ctx) => {
            await expect(
              ctx.runCodemode({
                scope,
                code: `async () => await models.extract({
                files: [{ path: "/workspace/inbox/notes.txt" }],
                instructions: "Read the note.",
                schema: { type: "object", properties: {}, required: [], additionalProperties: false },
              })`,
              }),
            ).rejects.toThrow(
              "MODELS_EXTRACT_INVALID_FILE: /workspace/inbox/notes.txt must contain a PDF",
            );
            expect(ctx.fakes.openaiResponses?.requests).toHaveLength(2);
          },
        ),
        then.billing.tracker({
          scope,
          period,
          meter: "models.extractions",
          quantity: "2",
          eventCount: "2",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "ai.tokens.output",
          quantity: "400",
          eventCount: "2",
        }),
        // Each call reads 3,000 tokens and writes 200: gpt-6-luna charges $0.10 and $0.50 per
        // million, gpt-6.1-sol $2 and $10, so $0.0004 and $0.008.
        then.billing.tracker({
          scope,
          period,
          meter: "ai.cost.total",
          quantity: "8400000",
          eventCount: "2",
        }),
      ],
    }),
  );
});

const blobBuckets = blobsR2BucketsFromEnv(
  {
    BLOBS_R2_ENDPOINT: "/cdn-cgi/local/r2/s3",
    BLOBS_R2_BUCKET: "backoffice-blobs",
    BLOBS_R2_ACCESS_KEY_ID: "access-key-1",
    BLOBS_R2_SECRET_ACCESS_KEY: "secret-key-1",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
  },
  "local",
);
assert(blobBuckets);

/** Stores a blob as a person would: Backoffice starts the upload, the bytes go straight to R2. */
async function storeBlob(
  ctx: BackofficeScenarioContext,
  r2: FakeR2,
  blob: { key: string; contentType: string; bytes: Uint8Array<ArrayBuffer> },
) {
  const { result: upload } = await ctx.runCodemode({
    scope,
    code: `async () => await blobs.createUpload(${JSON.stringify({ key: blob.key, contentType: blob.contentType })})`,
  });
  const { uploadId, url, headers } = upload as {
    uploadId: string;
    url: string;
    headers: Record<string, string>;
  };
  const response = await requestFromOutside(r2, url, { method: "PUT", headers, body: blob.bytes });
  assert(response.ok, `PUT failed with ${response.status}`);
  await ctx.runCodemode({
    scope,
    code: `async () => await blobs.completeUpload({ uploadId: ${JSON.stringify(uploadId)} })`,
  });
}

test("models read a scan and a photo kept as blobs, too large for the workspace", async () => {
  const r2 = createFakeR2(blobBuckets);
  // Larger than one range read of the blobs route, so the scan arrives in several.
  const scan = new Uint8Array(9 * 1024 ** 2);
  scan.set(new TextEncoder().encode(invoicePdf));
  scan.fill(0x20, invoicePdf.length);
  const photo = new Uint8Array(STATE_FILE_MAX_BYTES + 1);
  photo.set(base64ToBytes(pngBase64));
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "models.extract and models.classify read blobs",
      objects: {
        ...allLocalObjects,
        BLOBS: (input) =>
          new BlobsObject({ ...input, storage: { buckets: blobBuckets, fetch: r2.fetch } }),
      },
      fakes: ({ fake }) => ({
        openaiResponses: fake.openaiResponses({
          output: { supplier: "Brass & Co", invoiceNumber: "2026-114", total: 1250.5 },
          inputTokens: 3000,
          outputTokens: 200,
        }),
        openaiDecisions: fake.openaiDecisions({ answers: reviewAnswers, inputTokens: 1200 }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("a person uploads a scanned invoice and a receipt photo", async (ctx) => {
          await storeBlob(ctx, r2, {
            key: "scans/invoice-2026-114.pdf",
            contentType: "application/pdf",
            bytes: scan,
          });
          await storeBlob(ctx, r2, {
            key: "photos/receipt.png",
            contentType: "image/png",
            bytes: photo,
          });
        }),
        then.assert("models.extract sends the whole scan to the model", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope,
            code: `async () => await models.extract({
              files: [{ blob: "scans/invoice-2026-114.pdf" }],
              instructions: "Read the supplier, invoice number, and total of this invoice.",
              schema: ${JSON.stringify(invoiceSchema)},
            })`,
          });
          expect(result).toEqual({
            output: { supplier: "Brass & Co", invoiceNumber: "2026-114", total: 1250.5 },
          });
          const [request] = ctx.fakes.openaiResponses?.requests ?? [];
          expect(request?.body).toMatchObject({
            input: [
              {
                content: [
                  {
                    type: "input_file",
                    filename: "invoice-2026-114.pdf",
                    file_data: `data:application/pdf;base64,${Buffer.from(scan).toString("base64")}`,
                  },
                  { type: "input_text" },
                ],
              },
            ],
          });
          expect(ctx.kernelActions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                operation: BACKOFFICE_PERMISSION.upload.read,
                resource: { kind: "blob", key: "scans/invoice-2026-114.pdf" },
              }),
            ]),
          );
        }),
        then.assert("models.classify judges the photo", async (ctx) => {
          const { result } = await ctx.runCodemode({
            scope,
            code: `async () => await models.classify({
              state: { brief: "A receipt" },
              images: [{ blob: "photos/receipt.png" }],
              questions: ${JSON.stringify(reviewQuestion)},
            })`,
          });
          expect(result).toEqual({ answers: reviewAnswers });
          expect(ctx.fakes.openaiDecisions?.requests[0]?.body).toMatchObject({
            input: [
              {
                content: [
                  { type: "input_text" },
                  {
                    type: "input_image",
                    image_url: `data:image/png;base64,${Buffer.from(photo).toString("base64")}`,
                  },
                ],
              },
            ],
          });
        }),
        then.assert("a missing blob never reaches the model", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope,
              code: `async () => await models.extract({
                files: [{ blob: "scans/missing.pdf" }],
                instructions: "Read the total.",
                schema: { type: "object", properties: { total: { type: "number" } } },
              })`,
            }),
          ).rejects.toThrow("BLOB_NOT_FOUND: blob scans/missing.pdf does not exist.");
          expect(ctx.fakes.openaiResponses?.requests).toHaveLength(1);
        }),
      ],
    }),
  );
});
