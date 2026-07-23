import { assert, describe, expect, test, vi } from "vitest";

import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";

import { queryOnce } from "@tanstack/react-db";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class DurableObject {
    constructor(..._args: unknown[]) {}
  }
  class RpcTarget {}
  class WorkerEntrypoint {}
  return { DurableObject, RpcTarget, WorkerEntrypoint };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import { buildPiSessionListingQuery, projectPiSessionListingRows } from "./session-listing";

const querySessionListing = (
  collections: Parameters<typeof buildPiSessionListingQuery>[1]["collections"],
  limit: number,
  workflowName = INTERACTIVE_CHAT_WORKFLOW_NAME,
) =>
  queryOnce((query) =>
    buildPiSessionListingQuery(query, {
      collections,
      workflowName,
      limit,
    }),
  );

describe("usePiSessionListing", () => {
  test("queries the real Pi outbox with the production filter, join, ordering, and limit", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "Pi session listing TanStack query",
        vars: () => ({
          firstSessionId: "",
          secondSessionId: "",
          thirdSessionId: "",
        }),
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1", name: "Ada Labs" }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ then, when }) => [
          when.pi.createSession({
            orgId: "org-1",
            name: "First session",
            captureSessionIdAs: "firstSessionId",
          }),
          when.pi.createSession({
            orgId: "org-1",
            name: "Second session",
            captureSessionIdAs: "secondSessionId",
          }),
          then.assert("assert the initial listing query", async (ctx) => {
            const database = ctx.tanstack.pi.forOrg("org-1");
            await database.drain();

            const rows = await querySessionListing(database.collections, 50);
            expect(rows.map((row) => row.sessionId).sort()).toEqual(
              [ctx.vars.firstSessionId, ctx.vars.secondSessionId].sort(),
            );
            assert(rows.every((row) => typeof row.workflowStatus === "string"));
            expect(await querySessionListing(database.collections, 50, "other-workflow")).toEqual(
              [],
            );
          }),
          when.pi.createSession({
            orgId: "org-1",
            name: "Third session",
            captureSessionIdAs: "thirdSessionId",
          }),
          then.assert(
            "assert the started listing catches up and applies its limit",
            async (ctx) => {
              const database = ctx.tanstack.pi.forOrg("org-1");
              await database.drain();

              const completeListing = await querySessionListing(database.collections, 50);
              expect(completeListing.map((row) => row.sessionId).sort()).toEqual(
                [ctx.vars.firstSessionId, ctx.vars.secondSessionId, ctx.vars.thirdSessionId].sort(),
              );

              const limitedListing = await querySessionListing(database.collections, 2);
              const storedSessions = await queryOnce((query) =>
                query.from({ session: database.collections.sessions }),
              );
              const expectedSessionIds = storedSessions
                .sort(
                  (left, right) =>
                    right.createdAt.getTime() - left.createdAt.getTime() ||
                    right.id.localeCompare(left.id),
                )
                .slice(0, 2)
                .map((session) => session.sessionId);
              expect(limitedListing.map((row) => row.sessionId)).toEqual(expectedSessionIds);

              const snapshot = projectPiSessionListingRows(limitedListing);
              expect(snapshot.sessions.map((session) => session.id)).toEqual(expectedSessionIds);
              assert(Object.values(snapshot.workflowStatuses).every(Boolean));
            },
          ),
        ],
      }),
    );
  });
});
