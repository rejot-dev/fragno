import { assert, describe, expect, test } from "vitest";

import { credit, debit, ledgerScenario } from "./ledger.test-support";

describe("settlement", () => {
  test("allocations settle open items within their outstanding amounts and can be undone", () =>
    ledgerScenario(async (ledger) => {
      await ledger.post({
        name: "invoice",
        journal: "sales",
        lines: [debit("ar", 12100n, { party: "alice-c" }), credit("revenue", 12100n)],
      });
      await ledger.post({
        name: "bob-invoice",
        journal: "sales",
        lines: [debit("ar", 5000n, { party: "bob-c" }), credit("revenue", 5000n)],
      });
      await ledger.post({
        name: "receipt",
        journal: "cashbook",
        lines: [debit("bank", 12100n), credit("ar", 12100n, { party: "alice-c" })],
      });
      const settle = { debit: ["invoice", 1], credit: ["receipt", 2] } as const;

      await ledger.refuses(
        () => ledger.allocate({ name: "x", ...settle, amount: 0n }),
        "ALLOCATION_AMOUNT_ZERO",
      );
      await ledger.allocate({ name: "a1", ...settle, amount: 10000n });
      await ledger.refuses(
        () => ledger.allocate({ name: "x", ...settle, amount: 2101n }),
        "ALLOCATION_EXCEEDS_OUTSTANDING",
      );
      await ledger.allocate({ name: "a2", ...settle, amount: 2100n });
      assert((await ledger.outstanding("invoice", 1)) === 0n);

      await ledger.reverseAllocation("a1");
      await ledger.refuses(() => ledger.reverseAllocation("a1"), "ALLOCATION_ALREADY_REVERSED");
      assert((await ledger.outstanding("invoice", 1)) === 10000n);
      assert((await ledger.outstanding("receipt", 2)) === 10000n);
      const [invoice, receipt] = await ledger.openItems("alice-c");
      expect(invoice).toMatchObject({
        entry: { entryNumber: 1 },
        allocations: [
          { id: ledger.id("a1"), creditItemId: receipt.id, amountMinor: "10000", reversed: true },
          { id: ledger.id("a2"), creditItemId: receipt.id, amountMinor: "2100", reversed: false },
        ],
      });
      expect(receipt.allocations.map((allocation) => allocation.debitItemId)).toEqual([
        invoice.id,
        invoice.id,
      ]);

      await ledger.refuses(
        () => ledger.allocate({ ...settle, name: "x", debit: ["bob-invoice", 1], amount: 100n }),
        "ALLOCATION_ITEMS_MISMATCH",
      );
      await ledger.refuses(
        () => ledger.allocate({ ...settle, name: "x", debit: ["receipt", 2], amount: 100n }),
        "ALLOCATION_SIDES_INVALID",
      );

      // Without an amount, an allocation settles all both items have outstanding.
      assert.equal(await ledger.allocate({ name: "a3", ...settle, amount: null }), 10000n);
      assert.equal(await ledger.outstanding("invoice", 1), 0n);
      await ledger.refuses(
        () => ledger.allocate({ name: "x", ...settle, amount: null }),
        "ALLOCATION_NOTHING_OUTSTANDING",
      );
    }));
});
