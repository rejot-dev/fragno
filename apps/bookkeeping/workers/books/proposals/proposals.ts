import type { FragnoId } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  withDatabase,
  type FragnoPublicConfigWithDatabase,
  type HookFn,
  type TypedUnitOfWork,
} from "@fragno-dev/db";

import {
  proposalsSchema,
  type AgentProposal,
  type ProposalAnswer,
  type ProposalRequest,
  type RequestChange,
} from "./schema";

/** The ID of the `management` table's one row. */
const MANAGEMENT = "management";

const proposalErrorMessages = {
  REQUEST_NOT_AWAITED:
    "This request no longer awaits an answer: it was answered, or asked again, since.",
  MANAGEMENT_CHANGED: "The firm keeping these books changed while asking. Ask again.",
} as const;

export type ProposalErrorCode = keyof typeof proposalErrorMessages;

/** Thrown by services when a request or answer does not count; aborts the whole transaction. */
export class ProposalError extends Error {
  readonly code: ProposalErrorCode;

  constructor(code: ProposalErrorCode) {
    super(proposalErrorMessages[code]);
    this.name = "ProposalError";
    this.code = code;
  }
}

type ProposalsConfig = {
  /** Tells the firm a request asked of its agent changed; retried until it succeeds. */
  tellFirm: (change: RequestChange) => Promise<void>;
};

const proposalsFragmentDefinition = defineFragment<ProposalsConfig>("proposals")
  .extend(withDatabase(proposalsSchema))
  .provideHooks(({ defineHook, config }) => ({
    onRequestChanged: defineHook(async function (change: RequestChange) {
      await config.tellFirm(change);
    }),
  }))
  .providesBaseService(({ defineService }) =>
    defineService({
      /** The proposals of the subjects of `ids` that have one. */
      getProposals: function (input: { ids: string[] }) {
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow.find("proposal", (b) => b.whereIndex("primary", (eb) => eb("id", "in", input.ids))),
          )
          .transformRetrieve(([rows]) =>
            rows.map((row) => ({ id: row.id.valueOf(), proposal: row.proposal })),
          )
          .build();
      },

      /**
       * Records that the bookkeeping agent was asked about subjects, `asked` of a firm under the
       * generation of the client's management read before. Asking again replaces an earlier answer,
       * and recording a request again does nothing; with `first`, so does a request about a subject
       * that has a proposal. A request with a `prompt` is announced to the firm as it is recorded;
       * one without waits for `announceRequest`. The subjects' fragments read whether each was
       * recorded. Returns the proposal in effect for each subject, in order.
       */
      requestProposals: function (input: {
        requests: {
          subjectId: string;
          requestId: string;
          prompt: string | null;
        }[];
        asked: { generation: number; firmId: string; by: string; at: string };
        first: boolean;
      }) {
        const { requests, asked, first } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow
              .find("proposal", (b) =>
                b.whereIndex("primary", (eb) =>
                  eb(
                    "id",
                    "in",
                    requests.map((request) => request.subjectId),
                  ),
                ),
              )
              .findFirst("management", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", MANAGEMENT)),
              ),
          )
          .transformRetrieve(([rows, management]) => ({
            management,
            planned: requests.map(({ subjectId, requestId, prompt }) => {
              const row = rows.find((candidate) => candidate.id.valueOf() === subjectId) ?? null;
              const current = row?.proposal ?? null;
              const kept =
                current !== null &&
                (first || (current.status === "requested" && current.requestId === requestId))
                  ? current
                  : null;
              const request: ProposalRequest = {
                status: "requested",
                requestId,
                ...asked,
                announced: prompt !== null,
              };
              return {
                subjectId,
                row,
                prompt,
                inEffect: kept ?? request,
                recorded: kept === null,
              };
            }),
          }))
          .mutate(({ uow, retrieveResult: { management, planned } }) => {
            // The firm read under an earlier generation may be one whose requests were withdrawn
            // already, which would leave these with it.
            if (management && asked.generation < management.generation) {
              throw new ProposalError("MANAGEMENT_CHANGED");
            }
            recordLatestGeneration(uow, management, asked.generation);
            for (const { subjectId, row, prompt, inEffect, recorded } of planned) {
              if (!recorded) {
                continue;
              }
              recordProposal(uow, subjectId, row, inEffect);
              if (prompt !== null) {
                announce(uow, subjectId, inEffect as ProposalRequest, prompt);
              }
            }
            return planned.map(({ subjectId, inEffect }) => ({ subjectId, proposal: inEffect }));
          })
          .build();
      },

      /**
       * Tells the firm of a request recorded without announcing it, such as once a document's file
       * is shared with it, unless it was told already or the request no longer awaits an answer.
       * Returns whether the request awaits one.
       */
      announceRequest: function (input: { subjectId: string; requestId: string; prompt: string }) {
        const { subjectId, requestId, prompt } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow.findFirst("proposal", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", subjectId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            const current = row?.proposal ?? null;
            if (!(row && current?.status === "requested" && current.requestId === requestId)) {
              return false;
            }
            if (!current.announced) {
              const announced = { ...current, announced: true };
              recordProposal(uow, subjectId, row, announced);
              announce(uow, subjectId, announced, prompt);
            }
            return true;
          })
          .build();
      },

      /**
       * Records an answer to a request about a subject. An answer to `request` counts only while
       * the subject awaits that request's answer, so a request asked again, or answered, takes no
       * late answer to it; an answer to no request replaces any proposal.
       */
      answerRequest: function (input: {
        subjectId: string;
        request: string | null;
        answer: ProposalAnswer<unknown>;
      }) {
        const { subjectId, request, answer } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow.findFirst("proposal", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", subjectId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            const current = row?.proposal ?? null;
            if (
              request !== null &&
              !(current?.status === "requested" && current.requestId === request)
            ) {
              throw new ProposalError("REQUEST_NOT_AWAITED");
            }
            if (current?.status === "requested") {
              settle(uow, subjectId, current, answer.status, answer.at);
            }
            recordProposal(uow, subjectId, row, answer);
            return answer;
          })
          .build();
      },

      /**
       * Withdraws the request a subject awaits an answer to, if any, as when a person books or
       * dismisses it first: no answer to it counts.
       */
      withdrawRequest: function (input: { subjectId: string; reason: string }) {
        const { subjectId, reason } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow.findFirst("proposal", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", subjectId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [row] }) => {
            const current = row?.proposal ?? null;
            if (row && current?.status === "requested") {
              const withdrawal = {
                status: "withdrawn",
                reason,
                at: new Date().toISOString(),
              } as const;
              settle(uow, subjectId, current, withdrawal.status, withdrawal.at);
              recordProposal(uow, subjectId, row, withdrawal);
            }
          })
          .build();
      },

      /**
       * Withdraws the requests awaiting an answer that were asked before the client's management
       * reached `generation`, so no answer to them counts, and refuses requests asked under earlier
       * generations from now on.
       */
      withdrawRequests: function (input: { reason: string; generation: number }) {
        const { reason, generation } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow
              .find("proposal", (b) => b.whereIndex("primary"))
              .findFirst("management", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", MANAGEMENT)),
              ),
          )
          .mutate(({ uow, retrieveResult: [rows, management] }) => {
            recordLatestGeneration(uow, management, generation);
            const withdrawal = {
              status: "withdrawn",
              reason,
              at: new Date().toISOString(),
            } as const;
            for (const row of rows) {
              const { proposal } = row;
              if (proposal.status === "requested" && proposal.generation < generation) {
                settle(uow, row.id.valueOf(), proposal, withdrawal.status, withdrawal.at);
                uow.update("proposal", row.id, (b) => b.set({ proposal: withdrawal }).check());
              }
            }
          })
          .build();
      },
    }),
  )
  .build();

type ProposalsUnitOfWork = TypedUnitOfWork<
  typeof proposalsSchema,
  [],
  unknown,
  { onRequestChanged: HookFn<RequestChange> }
>;

/**
 * Records the latest generation of the client's management the books heard of. Every request and
 * withdrawal writes it, even unchanged, so the two conflict and one retries instead of passing each
 * other: a request recorded meanwhile would be missed by the withdrawal, or recorded after it.
 */
function recordLatestGeneration(
  uow: ProposalsUnitOfWork,
  management: { id: FragnoId; generation: number } | null,
  generation: number,
) {
  if (management === null) {
    // Another request or withdrawal created it: retrying reads it.
    uow.create("management", { id: MANAGEMENT, generation }, { retryOnUniqueConflict: () => true });
    return;
  }
  uow.update("management", management.id, (b) =>
    b.set({ generation: Math.max(generation, management.generation) }).check(),
  );
}

function recordProposal(
  uow: ProposalsUnitOfWork,
  subjectId: string,
  row: { id: FragnoId } | null,
  proposal: AgentProposal<unknown>,
) {
  if (row === null) {
    // A concurrent request or answer created it: retrying reads it.
    uow.create("proposal", { id: subjectId, proposal }, { retryOnUniqueConflict: () => true });
    return;
  }
  uow.update("proposal", row.id, (b) => b.set({ proposal }).check());
}

/** The ID of the hook announcing a request, by which its delivery is read. */
export function announcementHookId(requestId: string): string {
  return `announce:${requestId}`;
}

/** Tells the firm of a request, once its transaction commits. */
function announce(
  uow: ProposalsUnitOfWork,
  subjectId: string,
  request: ProposalRequest,
  prompt: string,
) {
  const { requestId, firmId, at } = request;
  uow.triggerHook(
    "onRequestChanged",
    { subjectId, requestId, firmId, status: "requested", prompt, at },
    { id: announcementHookId(requestId) },
  );
}

/** Tells the firm how a request it was told of ended; one it was not told of concerns it not. */
function settle(
  uow: ProposalsUnitOfWork,
  subjectId: string,
  request: ProposalRequest,
  status: Exclude<RequestChange["status"], "requested">,
  at: string,
) {
  if (!request.announced) {
    return;
  }
  const { requestId, firmId } = request;
  uow.triggerHook("onRequestChanged", {
    subjectId,
    requestId,
    firmId,
    status,
    prompt: null,
    at,
  });
}

export function createProposalsFragment(
  config: ProposalsConfig,
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(proposalsFragmentDefinition).withConfig(config).withOptions(options).build();
}
