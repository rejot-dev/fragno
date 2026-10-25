import type { DatabaseServiceContext } from "@fragno-dev/db";

import { LedgerError } from "./errors";
import { assertAmountInRange } from "./posting";
import { ledgerSchema } from "./schema";

type LedgerServiceContext = DatabaseServiceContext<{}>;

export type AllocateInput = {
  debitItemId: string;
  creditItemId: string;
  /** Positive, in the items' shared currency; null settles all both items have outstanding. */
  amountMinor: bigint | null;
  /** Opaque actor identifier from the application. */
  allocatedBy: string;
};

export const settlementServices = {
  /** Settles part of a debit open item against a credit open item of the same party account. */
  allocate: function (this: LedgerServiceContext, input: AllocateInput) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow
          .findFirst("openItem", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.debitItemId)),
          )
          .findFirst("openItem", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.creditItemId)),
          ),
      )
      .mutate(({ uow, retrieveResult: [debitItem, creditItem] }) => {
        if (!debitItem || !creditItem) {
          throw new LedgerError("OPEN_ITEM_NOT_FOUND", "The open item does not exist.");
        }
        if (debitItem.side !== "debit" || creditItem.side !== "credit") {
          throw new LedgerError(
            "ALLOCATION_SIDES_INVALID",
            "Allocations settle a debit open item against a credit one.",
          );
        }
        if (
          debitItem.partyAccountId.internalId !== creditItem.partyAccountId.internalId ||
          debitItem.currency.internalId !== creditItem.currency.internalId
        ) {
          throw new LedgerError(
            "ALLOCATION_ITEMS_MISMATCH",
            "Allocated items share their party account and currency.",
          );
        }
        if (input.amountMinor !== null) {
          assertAmountInRange(input.amountMinor);
          if (input.amountMinor === 0n) {
            throw new LedgerError("ALLOCATION_AMOUNT_ZERO", "An allocation needs an amount.");
          }
        }
        const amountMinor =
          input.amountMinor ??
          (debitItem.outstandingMinor < creditItem.outstandingMinor
            ? debitItem.outstandingMinor
            : creditItem.outstandingMinor);
        if (amountMinor === 0n) {
          throw new LedgerError(
            "ALLOCATION_NOTHING_OUTSTANDING",
            "One of the items has nothing outstanding.",
          );
        }
        if (amountMinor > debitItem.outstandingMinor || amountMinor > creditItem.outstandingMinor) {
          throw new LedgerError(
            "ALLOCATION_EXCEEDS_OUTSTANDING",
            "The allocation exceeds an item's outstanding amount.",
          );
        }
        uow.update("openItem", debitItem.id, (b) =>
          b.set({ outstandingMinor: debitItem.outstandingMinor - amountMinor }).check(),
        );
        uow.update("openItem", creditItem.id, (b) =>
          b.set({ outstandingMinor: creditItem.outstandingMinor - amountMinor }).check(),
        );
        const id = uow.create("allocation", {
          debitItemId: debitItem.id,
          creditItemId: creditItem.id,
          amountMinor,
          allocatedAt: uow.now(),
          allocatedBy: input.allocatedBy,
        });
        return { id: id.valueOf(), amountMinor };
      })
      .build();
  },

  /** Undoes an allocation, restoring both items' outstanding amounts. */
  reverseAllocation: function (
    this: LedgerServiceContext,
    input: { allocationId: string; reversedBy: string },
  ) {
    return this.serviceTx(ledgerSchema)
      .retrieve((uow) =>
        uow.findFirst("allocation", (b) =>
          b
            .whereIndex("primary", (eb) => eb("id", "=", input.allocationId))
            .joinOne("debitItem", "openItem", (item) =>
              item.onIndex("primary", (eb) => eb("id", "=", eb.parent("debitItemId"))),
            )
            .joinOne("creditItem", "openItem", (item) =>
              item.onIndex("primary", (eb) => eb("id", "=", eb.parent("creditItemId"))),
            )
            .joinOne("reversal", "allocationReversal", (reversal) =>
              reversal
                .onIndex("idx_allocation_reversal_allocation", (eb) =>
                  eb("allocationId", "=", eb.parent("id")),
                )
                .select(["id"]),
            ),
        ),
      )
      .mutate(({ uow, retrieveResult: [allocation] }) => {
        // The joins always find both items: allocations reference theirs.
        if (!allocation?.debitItem || !allocation.creditItem) {
          throw new LedgerError("ALLOCATION_NOT_FOUND", "The allocation does not exist.");
        }
        if (allocation.reversal) {
          throw new LedgerError(
            "ALLOCATION_ALREADY_REVERSED",
            "The allocation is already reversed.",
          );
        }
        const { debitItem, creditItem } = allocation;
        uow.update("openItem", debitItem.id, (b) =>
          b.set({ outstandingMinor: debitItem.outstandingMinor + allocation.amountMinor }).check(),
        );
        uow.update("openItem", creditItem.id, (b) =>
          b.set({ outstandingMinor: creditItem.outstandingMinor + allocation.amountMinor }).check(),
        );
        const id = uow.create("allocationReversal", {
          allocationId: allocation.id,
          reversedAt: uow.now(),
          reversedBy: input.reversedBy,
        });
        return { id: id.valueOf() };
      })
      .build();
  },
};
