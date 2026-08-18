import { describe, test, vi } from "vitest";

import type { PiOperationCompletedHookPayload } from "@fragno-dev/pi-harness/types";

import { PI_BILLING_ORGANIZATION_ID_METADATA_KEY } from "@/fragno/pi/pi-shared";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  RpcTarget: class MockRpcTarget {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "./scenario";

const operationPayload = (
  sessionId: string,
  metadata: Record<string, unknown> = {},
): PiOperationCompletedHookPayload => ({
  actor: { userId: "user-1" },
  workflowName: "interactive-chat-workflow",
  sessionId,
  metadata: {
    model: { provider: "openai", name: "gpt-5.6-luna" },
    ...metadata,
  },
  stepName: "command:command-1",
  operationId: `interactive-chat-workflow:${sessionId}:command:command-1`,
  operation: "prompt",
  modelCalls: [
    {
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: {
        input: 80,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100,
        cost: {
          input: 0.00008,
          output: 0.00002,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.0001,
        },
      },
      stopReason: "stop",
      timestamp: Date.parse("2026-08-17T10:00:00.000Z"),
    },
  ],
  usage: {
    input: 80,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    cost: {
      input: 0.00008,
      output: 0.00002,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.0001,
    },
  },
});

type RevokedMembershipScenarioVars = {
  sessionId?: string;
};

describe("scenario Pi billing", () => {
  test("terminally errors a user workflow when billing organization membership is revoked", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<RevokedMembershipScenarioVars>({
        name: "Pi user session reauthorizes its billing organization before model execution",
        vars: () => ({}),
        options: { allowErroredWorkflows: true },
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({
            id: "org-1",
            name: "Pi Billing Org",
            ownerUserId: "owner",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
          given.pi.configured({ scope: { kind: "user", userId: "member" } }),
        ],
        steps: ({ when, then }) => [
          when.pi.createSession({
            scope: { kind: "user", userId: "member" },
            userId: "member",
            billingOrganizationId: "org-1",
            captureSessionIdAs: "sessionId",
          }),
          then.pi.session({
            scope: { kind: "user", userId: "member" },
            userId: "member",
            sessionId: (ctx) => ctx.vars.sessionId!,
            workflow: { status: "waiting" },
          }),
          when.auth.removeMember({ orgId: "org-1", userId: "member" }),
          when.pi.promptSession({
            scope: { kind: "user", userId: "member" },
            userId: "member",
            sessionId: (ctx) => ctx.vars.sessionId!,
            text: "run",
          }),
          then.pi.session({
            scope: { kind: "user", userId: "member" },
            userId: "member",
            sessionId: (ctx) => ctx.vars.sessionId!,
            workflow: {
              status: "errored",
              error: { name: "PiSessionBillingOrganizationAccessDeniedError" },
            },
          }),
        ],
      }),
    );
  });

  test("routes Pi operation usage to the organization that owns the scope", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Pi operation billing follows scope ownership",
        setup: ({ given }) => [
          given.auth.user({ id: "user-1", email: "user@example.com" }),
          given.auth.organization({
            id: "org-1",
            name: "Ada Labs",
            ownerUserId: "user-1",
            ownerRoles: ["owner"],
          }),
        ],
        steps: ({ when, then }) => [
          when.pi.operationCompleted({
            scope: { kind: "org", orgId: "org-1" },
            payload: operationPayload("org-session"),
            hookId: "org-hook",
            idempotencyKey: "billing:org-hook",
          }),
          then.pi.operationBilling({
            hookId: "org-hook",
            recorded: true,
            billingOrganizationId: "org-1",
          }),
          then.billing.tracker({
            organizationId: "org-1",
            scope: { kind: "org", orgId: "org-1" },
            period: "2026-08",
            meter: "ai.tokens.total",
            quantity: "100",
            eventCount: "1",
          }),

          when.pi.operationCompleted({
            scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
            payload: operationPayload("project-session"),
            hookId: "project-hook",
            idempotencyKey: "billing:project-hook",
          }),
          then.pi.operationBilling({
            hookId: "project-hook",
            recorded: true,
            billingOrganizationId: "org-1",
          }),
          then.billing.tracker({
            organizationId: "org-1",
            scope: { kind: "project", orgId: "org-1", projectId: "project-1" },
            period: "2026-08",
            meter: "ai.tokens.total",
            quantity: "100",
            eventCount: "1",
          }),

          when.pi.operationCompleted({
            scope: { kind: "user", userId: "user-1" },
            payload: operationPayload("user-session", {
              [PI_BILLING_ORGANIZATION_ID_METADATA_KEY]: "org-1",
            }),
            hookId: "user-hook",
            idempotencyKey: "billing:user-hook",
          }),
          then.pi.operationBilling({
            hookId: "user-hook",
            recorded: true,
            billingOrganizationId: "org-1",
          }),
          then.billing.tracker({
            organizationId: "org-1",
            scope: { kind: "user", userId: "user-1" },
            period: "2026-08",
            meter: "ai.tokens.total",
            quantity: "100",
            eventCount: "1",
          }),

          when.pi.operationCompleted({
            scope: { kind: "system" },
            payload: operationPayload("system-session"),
            hookId: "system-hook",
            idempotencyKey: "billing:system-hook",
          }),
          then.pi.operationBilling({
            hookId: "system-hook",
            recorded: false,
            billingOrganizationId: null,
          }),
        ],
      }),
    );
  });
});
