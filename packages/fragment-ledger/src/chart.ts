import type { DatabaseServiceContext } from "@fragno-dev/db";

import { LedgerError } from "./errors";
import {
  ledgerSchema,
  type AccountClassification,
  type DimensionRules,
  type PartyRole,
  type Side,
} from "./schema";

type LedgerServiceContext = DatabaseServiceContext<{}>;

export type CreateAccountInput = {
  code: string;
  name: string;
  classification: AccountClassification;
  normalSide: Side;
  /** Null: the account accepts postings in any currency. */
  currency: string | null;
  dimensionRules: DimensionRules;
};

/**
 * What can change about an account. Its classification, normal side, and currency never do, so
 * posted history keeps its meaning; replace a wrong account with a new one.
 */
export type UpdateAccountInput = {
  accountId: string;
  name: string;
  active: boolean;
  dimensionRules: DimensionRules;
};

export type CreatePartyAccountInput = {
  /** An existing party, or a new one with this name. */
  party: { id: string } | { name: string };
  role: PartyRole;
  code: string;
  controlAccountId: string;
};

const controlAccountRoles = {
  customer: "receivable",
  supplier: "payable",
} as const satisfies Record<PartyRole, string>;

export const chartServices = {
  createAccount: function (this: LedgerServiceContext, input: CreateAccountInput) {
    const dimensionIds = Object.keys(input.dimensionRules);
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("account", (b) =>
            b.whereIndex("idx_account_code", (eb) => eb("code", "=", input.code)),
          )
          .find("currency", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "in", input.currency ? [input.currency] : [])),
          )
          .find("dimension", (b) => b.whereIndex("primary", (eb) => eb("id", "in", dimensionIds))),
      )
      .mutate(({ uow, retrieveResult: [existing, [currency], dimensions] }) => {
        if (existing) {
          throw new LedgerError("ACCOUNT_CODE_TAKEN", `Account ${input.code} already exists.`);
        }
        if (input.currency && !currency) {
          throw new LedgerError("CURRENCY_NOT_FOUND", `Currency ${input.currency} does not exist.`);
        }
        assertDimensionsExist(dimensionIds, dimensions);
        const id = uow.create("account", {
          code: input.code,
          name: input.name,
          type: input.classification.type,
          role: input.classification.role,
          normalSide: input.normalSide,
          currency: currency?.id ?? null,
          active: true,
          dimensionRules: input.dimensionRules,
        });
        return { id: id.valueOf() };
      })
      .build();
  },

  updateAccount: function (this: LedgerServiceContext, input: UpdateAccountInput) {
    const dimensionIds = Object.keys(input.dimensionRules);
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("account", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.accountId)),
          )
          .find("dimension", (b) => b.whereIndex("primary", (eb) => eb("id", "in", dimensionIds))),
      )
      .mutate(({ uow, retrieveResult: [account, dimensions] }) => {
        if (!account) {
          throw new LedgerError("ACCOUNT_NOT_FOUND", "The account does not exist.");
        }
        assertDimensionsExist(dimensionIds, dimensions);
        uow.update("account", account.id, (b) =>
          b
            .set({ name: input.name, active: input.active, dimensionRules: input.dimensionRules })
            .check(),
        );
      })
      .build();
  },

  createJournal: function (this: LedgerServiceContext, input: { code: string; name: string }) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("journal", (b) =>
          b.whereIndex("idx_journal_code", (eb) => eb("code", "=", input.code)),
        ),
      )
      .mutate(({ uow, retrieveResult: [existing] }) => {
        if (existing) {
          throw new LedgerError("JOURNAL_CODE_TAKEN", `Journal ${input.code} already exists.`);
        }
        const id = uow.create("journal", {
          code: input.code,
          name: input.name,
          lastEntryNumber: 0,
        });
        return { id: id.valueOf() };
      })
      .build();
  },

  createDimension: function (this: LedgerServiceContext, input: { code: string; name: string }) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("dimension", (b) =>
          b.whereIndex("idx_dimension_code", (eb) => eb("code", "=", input.code)),
        ),
      )
      .mutate(({ uow, retrieveResult: [existing] }) => {
        if (existing) {
          throw new LedgerError("DIMENSION_CODE_TAKEN", `Dimension ${input.code} already exists.`);
        }
        const id = uow.create("dimension", { code: input.code, name: input.name });
        return { id: id.valueOf() };
      })
      .build();
  },

  createDimensionValue: function (
    this: LedgerServiceContext,
    input: { dimensionId: string; code: string; name: string },
  ) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("dimension", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.dimensionId)),
          )
          .findFirst("dimensionValue", (b) =>
            b.whereIndex("idx_dimension_value_code", (eb) =>
              eb.and(eb("dimensionId", "=", input.dimensionId), eb("code", "=", input.code)),
            ),
          ),
      )
      .mutate(({ uow, retrieveResult: [dimension, existing] }) => {
        if (!dimension) {
          throw new LedgerError("DIMENSION_NOT_FOUND", "The dimension does not exist.");
        }
        if (existing) {
          throw new LedgerError(
            "DIMENSION_VALUE_CODE_TAKEN",
            `Dimension value ${input.code} already exists.`,
          );
        }
        const id = uow.create("dimensionValue", {
          dimensionId: dimension.id,
          code: input.code,
          name: input.name,
        });
        return { id: id.valueOf() };
      })
      .build();
  },

  /**
   * Makes a party a customer or a supplier, with its own code and control account. A new party is
   * created with its first account, so parties always have one.
   */
  createPartyAccount: function (this: LedgerServiceContext, input: CreatePartyAccountInput) {
    // A new party has no accounts yet: an empty list finds nothing.
    const partyIds = "id" in input.party ? [input.party.id] : [];
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .find("party", (b) => b.whereIndex("primary", (eb) => eb("id", "in", partyIds)))
          .findFirst("account", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.controlAccountId)),
          )
          .findFirst("partyAccount", (b) =>
            b.whereIndex("idx_party_account_party_role", (eb) =>
              eb.and(eb("partyId", "in", partyIds), eb("role", "=", input.role)),
            ),
          )
          .findFirst("partyAccount", (b) =>
            b.whereIndex("idx_party_account_role_code", (eb) =>
              eb.and(eb("role", "=", input.role), eb("code", "=", input.code)),
            ),
          ),
      )
      .mutate(({ uow, retrieveResult: [parties, controlAccount, sameRole, sameCode] }) => {
        if (partyIds.length !== parties.length) {
          throw new LedgerError("PARTY_NOT_FOUND", "The party does not exist.");
        }
        if (!controlAccount) {
          throw new LedgerError("ACCOUNT_NOT_FOUND", "The control account does not exist.");
        }
        if (controlAccount.role !== controlAccountRoles[input.role]) {
          throw new LedgerError(
            "CONTROL_ACCOUNT_INVALID",
            `A ${input.role} posts to a ${controlAccountRoles[input.role]} account.`,
          );
        }
        if (sameRole) {
          throw new LedgerError("PARTY_ROLE_TAKEN", `The party is already a ${input.role}.`);
        }
        if (sameCode) {
          throw new LedgerError(
            "PARTY_ACCOUNT_CODE_TAKEN",
            `A ${input.role} with code ${input.code} already exists.`,
          );
        }
        const partyId =
          "id" in input.party ? parties[0].id : uow.create("party", { name: input.party.name });
        const id = uow.create("partyAccount", {
          partyId,
          role: input.role,
          code: input.code,
          controlAccountId: controlAccount.id,
        });
        return { id: id.valueOf(), partyId: partyId.valueOf() };
      })
      .build();
  },
};

function assertDimensionsExist(
  dimensionIds: string[],
  dimensions: { id: { externalId: string } }[],
) {
  const found = new Set(dimensions.map((dimension) => dimension.id.externalId));
  const missing = dimensionIds.find((id) => !found.has(id));
  if (missing) {
    throw new LedgerError("DIMENSION_NOT_FOUND", `Dimension ${missing} does not exist.`);
  }
}
