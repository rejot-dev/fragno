import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { createLedgerFragment } from "@fragno-dev/ledger";

import { partyDetailsSchema } from "./schema";

type LedgerServices = ReturnType<typeof createLedgerFragment>["services"];

/** A customer's or supplier's company details; null where the books do not know one. */
export type PartyDetails = {
  registrationNumber: string | null;
  vatNumber: string | null;
  /** In electronic form, as `parseIban` gives it. */
  iban: string | null;
  address: string | null;
};

/** The details as last saved, by whom and when; null fields throughout until someone saves. */
export type PartyDetailsView = PartyDetails & { updatedAt: Date | null; updatedBy: string | null };

export class PartyDetailsError extends Error {
  readonly code = "PARTY_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "PartyDetailsError";
  }
}

const NO_DETAILS: PartyDetailsView = {
  registrationNumber: null,
  vatNumber: null,
  iban: null,
  address: null,
  updatedAt: null,
  updatedBy: null,
};

const partyDetailsFragmentDefinition = defineFragment("party-details")
  .extend(withDatabase(partyDetailsSchema))
  .usesService<"ledger", LedgerServices>("ledger")
  .providesBaseService(({ defineService, serviceDeps }) =>
    defineService({
      getPartyDetails: function (partyId: string) {
        return this.serviceTx(partyDetailsSchema)
          .retrieve((uow) =>
            uow.findFirst("partyDetails", (b) =>
              b.whereIndex("idx_party_details_party", (eb) => eb("partyId", "=", partyId)),
            ),
          )
          .transformRetrieve(
            ([row]): PartyDetailsView =>
              row
                ? {
                    registrationNumber: row.registrationNumber,
                    vatNumber: row.vatNumber,
                    iban: row.iban,
                    address: row.address,
                    updatedAt: row.updatedAt,
                    updatedBy: row.updatedBy,
                  }
                : NO_DETAILS,
          )
          .build();
      },

      /** Replaces a party's details, whichever were known before. */
      savePartyDetails: function (input: {
        partyId: string;
        details: PartyDetails;
        updatedBy: string;
      }) {
        return this.serviceTx(partyDetailsSchema)
          .withServiceCalls(() => [serviceDeps.ledger.getParty(input.partyId)] as const)
          .retrieve((uow) =>
            uow.findFirst("partyDetails", (b) =>
              b.whereIndex("idx_party_details_party", (eb) => eb("partyId", "=", input.partyId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [existing], serviceIntermediateResult: [party] }) => {
            // The ledger never deletes parties, so one that exists now always will.
            if (party === null) {
              throw new PartyDetailsError("This customer or supplier does not exist.");
            }
            const values = { ...input.details, updatedAt: uow.now(), updatedBy: input.updatedBy };
            if (existing) {
              uow.update("partyDetails", existing.id, (b) => b.set(values).check());
              return;
            }
            uow.create(
              "partyDetails",
              { partyId: input.partyId, ...values },
              // Saved at once by someone else: retrying replaces theirs, as saving after would.
              { retryOnUniqueConflict: () => true },
            );
          })
          .build();
      },
    }),
  )
  .build();

export function createPartyDetailsFragment(
  options: FragnoPublicConfigWithDatabase,
  services: { ledger: LedgerServices },
) {
  return instantiate(partyDetailsFragmentDefinition)
    .withConfig({})
    .withOptions(options)
    .withServices(services)
    .build();
}
