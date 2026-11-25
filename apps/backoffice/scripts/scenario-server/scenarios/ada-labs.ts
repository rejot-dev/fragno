// Ada Labs triages its support requests with a workflow: each request it receives is filed with a
// priority. `pnpm scenario-server` serves Backoffice from this scenario, and its view follows Ada
// through the app as the requests come in.
import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import { allLocalObjects } from "../../../app/backoffice-runtime/all-local-objects";
import {
  backofficeFiles,
  defineBackofficeScenario,
  type BackofficeScenarioContext,
} from "../../../app/fragno/automation/scenario";
import type { ScenarioModuleInput } from "../scenario-server";

const DASHBOARD = "/backoffice/dashboard/org/ada-labs";
const TRIAGE_WORKFLOW_PATH = "/workspace/automations/triage-request.workflow.js";

const TRIAGE_WORKFLOW = `export default defineWorkflow(
  { name: "triage-request" },
  async (event, step) => {
    const request = event.payload;
    const priority = await step.do("decide the priority", async () =>
      /urgent|down|broken/i.test(request.subject) ? "high" : "normal",
    );
    await step.do("file the request", async () => {
      await store.set({
        key: "requests/" + event.id,
        value: priority + ": " + request.subject + " (" + request.from + ")",
        category: ["support"],
      });
    });
    return { priority };
  },
);
`;

/** Ada Labs' ID, which creating it captured. */
function orgId(ctx: BackofficeScenarioContext): string {
  return String(ctx.vars.orgId);
}

function supportRequest(
  ctx: BackofficeScenarioContext,
  input: { id: string; subject: string; from: string },
): AutomationEvent {
  const scope = { kind: "org", orgId: orgId(ctx), jurisdiction: null } as const;
  return {
    id: input.id,
    scopeRestriction: null,
    scope,
    source: "support",
    eventType: "request.received",
    occurredAt: new Date(ctx.runtime.now()).toISOString(),
    sequence: null,
    payload: { subject: input.subject, from: input.from },
    actors: {
      initiator: { scope: "internal", type: "system", id: "scenario", role: "initiator" },
      principal: null,
      delegation: [],
    },
    subject: { scope },
    causation: { kind: "origin" },
  };
}

export default function adaLabs({ origin, view, later }: ScenarioModuleInput) {
  return defineBackofficeScenario({
    name: "Ada Labs triages support requests",
    objects: allLocalObjects,
    env: { DOCS_PUBLIC_BASE_URL: origin },
    files: backofficeFiles.workspace(),
    vars: () => ({ ada: "", orgId: "" }),
    setup: ({ given, when }) => [
      // Signed up at the server's origin, so the browser can take over Ada's session cookie.
      when.auth.signUp({ email: "ada@ada-labs.example", origin, captureSessionCookieAs: "ada" }),
      // As in the app, so Ada Labs starts as a new organization does.
      when.auth.createOrganization({
        cookie: ({ vars }) => vars.ada,
        name: "Ada Labs",
        slug: "ada-labs",
        captureOrganizationIdAs: "orgId",
        origin,
      }),
      later("Ada writes the triage workflow", (ctx) =>
        given.direct.file({
          orgId: orgId(ctx),
          path: TRIAGE_WORKFLOW_PATH,
          content: TRIAGE_WORKFLOW,
        }),
      ),
      later("Ada routes support requests to it", (ctx) =>
        given.router.route({
          orgId: orgId(ctx),
          id: "triage-support-requests",
          name: "Triage support requests",
          enabled: true,
          trigger: {
            kind: "event",
            source: "support",
            eventType: "request.received",
            matcher: null,
          },
          priority: 50,
          action: {
            kind: "start_workflow",
            authority: {
              kind: "organization-automation",
              grants: [BACKOFFICE_PERMISSION.store.modify],
            },
            workflowScriptPath: TRIAGE_WORKFLOW_PATH,
            instanceIdTemplate: "triage-${event.id}",
          },
        }),
      ),
    ],
    steps: ({ when }) => [
      view.navigate(`/__scenario/sign-in/ada?to=${DASHBOARD}/map`, "Ada opens the Map"),
      view.highlight(
        { text: "Triage support requests" },
        "Every support request goes through this route to the triage workflow.",
      ),
      later("a customer asks about invoices", (ctx) =>
        when.automation.ingestEvent(
          supportRequest(ctx, {
            id: "request-1",
            subject: "Question about my last invoice",
            from: "grace@example.com",
          }),
        ),
      ),
      view.navigate(`${DASHBOARD}/activity`, "Ada opens the Activity"),
      view.highlight(
        { text: "Question about my last invoice" },
        "The request started a triage run.",
      ),
      later("a customer reports an outage", (ctx) =>
        when.automation.ingestEvent(
          supportRequest(ctx, {
            id: "request-2",
            subject: "Urgent: the dashboard is down",
            from: "linus@example.com",
          }),
        ),
      ),
      view.click({ text: "Urgent: the dashboard is down" }, "Ada opens the outage's run"),
      view.highlight(
        { text: "decide the priority" },
        "The workflow decided the priority, the same way every time.",
      ),
      later("a customer asks for a feature", (ctx) =>
        when.automation.ingestEvent(
          supportRequest(ctx, {
            id: "request-3",
            subject: "Could you add CSV exports?",
            from: "barbara@example.com",
          }),
        ),
      ),
    ],
  });
}
