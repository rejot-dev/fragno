import type { FragnoId } from "@fragno-dev/db/schema";

import { defineFragment, instantiate } from "@fragno-dev/core";
import {
  withDatabase,
  type FragnoPublicConfigWithDatabase,
  type TypedUnitOfWork,
} from "@fragno-dev/db";

import {
  proposalsSchema,
  type AgentProposal,
  type ProposalAnswer,
  type ProposalRequest,
} from "./schema";

type ProposalsUnitOfWork = TypedUnitOfWork<typeof proposalsSchema>;

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

/**
 * The bookkeeping agent's proposals for booking what the books are to book, and the generation of
 * the client's management they are asked under. Only whether the subject is to book is not theirs:
 * each subject's fragment calls these in its own transaction, which refuses the rest.
 */
const proposalsFragmentDefinition = defineFragment("proposals")
  .extend(withDatabase(proposalsSchema))
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
       * Records that the bookkeeping agent was asked about a subject, under the generation of the
       * client's management its request names, read before. Asking again replaces an earlier
       * answer, and recording a request again does nothing; with `first`, so does a request about
       * a subject that has a proposal. Its subject's fragment reads whether it was recorded.
       * Returns the proposal in effect.
       */
      requestProposal: function (input: {
        subjectId: string;
        request: ProposalRequest;
        first: boolean;
      }) {
        const { subjectId, request, first } = input;
        return this.serviceTx(proposalsSchema)
          .retrieve((uow) =>
            uow
              .findFirst("proposal", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", subjectId)),
              )
              .findFirst("management", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", MANAGEMENT)),
              ),
          )
          .transformRetrieve(([row, management]) => {
            const current = row?.proposal ?? null;
            const kept =
              current !== null &&
              (first || (current.status === "requested" && current.requestId === request.requestId))
                ? current
                : null;
            return { row, management, inEffect: kept ?? request, recorded: kept === null };
          })
          .mutate(({ uow, retrieveResult: { row, management, inEffect, recorded } }) => {
            // The firm read under an earlier generation may be one whose requests were withdrawn
            // already, which would leave this one with it.
            if (management && request.generation < management.generation) {
              throw new ProposalError("MANAGEMENT_CHANGED");
            }
            recordLatestGeneration(uow, management, request.generation);
            if (recorded) {
              recordProposal(uow, subjectId, row, request);
            }
            return inEffect;
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
            recordProposal(uow, subjectId, row, answer);
            return answer;
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
              if (row.proposal.status === "requested" && row.proposal.generation < generation) {
                uow.update("proposal", row.id, (b) => b.set({ proposal: withdrawal }).check());
              }
            }
          })
          .build();
      },
    }),
  )
  .build();

export function createProposalsFragment(options: FragnoPublicConfigWithDatabase) {
  return instantiate(proposalsFragmentDefinition).withConfig({}).withOptions(options).build();
}
