import { describe, expect, test, assert } from "vitest";

import { credit, debit, ledgerScenario } from "./ledger.test-support";

const sale = (party = "alice-c", amount = 12100n) => [
  debit("ar", amount, { party }),
  credit("revenue", amount),
];

describe("posting", () => {
  test("entries are numbered gaplessly per journal; refused postings take no number", () =>
    ledgerScenario(async (ledger) => {
      await ledger.post({ name: "e1", journal: "sales", lines: sale(), reference: "INV-1" });
      await ledger.refuses(
        () => ledger.post({ name: "x", journal: "sales", lines: sale(), reference: "INV-1" }),
        "ENTRY_REFERENCE_TAKEN",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "sales",
            lines: [debit("ar", 100n, { party: "alice-c" }), credit("revenue", 90n)],
          }),
        "ENTRY_UNBALANCED",
      );
      await ledger.post({ name: "e2", journal: "sales", lines: sale() });
      await ledger.post({
        name: "m1",
        journal: "memo",
        lines: [debit("costs", 500n, { dimensions: ["cc-sales"] }), credit("bank", 500n)],
        // References are unique per journal.
        reference: "INV-1",
      });
      // Posting the same entry twice at once posts it once.
      const twice = await Promise.allSettled(
        ["e3", "e3-again"].map((name) =>
          ledger.post({ name, journal: "sales", lines: sale(), reference: "INV-3" }),
        ),
      );
      expect(twice.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(twice.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "ENTRY_REFERENCE_TAKEN" },
      });

      expect((await ledger.entries("sales")).map((entry) => entry.entryNumber)).toEqual([3, 2, 1]);
      expect((await ledger.entries("memo")).map((entry) => entry.entryNumber)).toEqual([1]);
    }));

  test("concurrent postings take the next number in their journal and add up in balances", () =>
    ledgerScenario(async (ledger) => {
      await Promise.all(
        ["sales", "sales", "sales", "purchase", "memo", "cashbook"].map((journal, index) =>
          ledger.post({ name: `e${index}`, journal, lines: sale("alice-c", 100n) }),
        ),
      );

      expect((await ledger.entries("sales")).map((entry) => entry.entryNumber)).toEqual([3, 2, 1]);
      expect((await ledger.entries("memo")).map((entry) => entry.entryNumber)).toEqual([1]);
      expect(await ledger.trialBalance("p1")).toEqual({ "1300": [600n, 0n], "8000": [0n, 600n] });
    }));

  test("amounts of up to fifteen digits add up exactly, past what JSON numbers hold", () =>
    ledgerScenario(async (ledger) => {
      const largest = 999_999_999_999_999n;
      const lines = (amount: bigint) =>
        Array.from({ length: 11 }, () => [debit("bank", amount), credit("revenue", amount)]).flat();
      await ledger.refuses(
        () => ledger.post({ name: "x", journal: "memo", lines: lines(largest + 1n) }),
        "AMOUNT_OUT_OF_RANGE",
      );
      await ledger.post({ name: "e1", journal: "memo", lines: lines(largest) });

      // 11 × largest is odd and above 2^53, so no number could hold it.
      expect(await ledger.trialBalance("p1")).toEqual({
        "1100": [11n * largest, 0n],
        "8000": [0n, 11n * largest],
      });
    }));

  test("lines on control accounts are open items of a party that posts there", () =>
    ledgerScenario(async (ledger) => {
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "sales",
            lines: [debit("ap", 100n, { party: "alice-c" }), credit("revenue", 100n)],
          }),
        "PARTY_ACCOUNT_MISMATCH",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "sales",
            lines: [debit("ar", 100n), credit("revenue", 100n)],
          }),
        "OPEN_ITEM_REQUIRED",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "sales",
            lines: [
              debit("ar", 100n, { party: "alice-c" }),
              credit("revenue", 100n, { party: "bob-c" }),
            ],
          }),
        "OPEN_ITEM_NOT_ALLOWED",
      );
      await ledger.refuses(
        () =>
          ledger.createPartyAccount("alice-s", {
            party: "alice",
            role: "supplier",
            code: "S9",
            control: "ar",
          }),
        "CONTROL_ACCOUNT_INVALID",
      );
      // A refused account leaves no new party behind.
      await ledger.refuses(
        () =>
          ledger.createPartyAccount("carol-c", {
            party: "carol",
            role: "customer",
            code: "C1",
            control: "ar",
          }),
        "PARTY_ACCOUNT_CODE_TAKEN",
      );
      expect((await ledger.parties()).map((party) => party.name)).toEqual(["alice", "bob"]);
      await ledger.post({ name: "e1", journal: "sales", lines: sale() });

      expect(await ledger.openItems("alice-c")).toMatchObject([
        { side: "debit", currency: "EUR", dueDate: "2026-02-10", outstandingMinor: "12100" },
      ]);
    }));

  test("lines respect account currencies, functional amounts, and dimension rules", () =>
    ledgerScenario(async (ledger) => {
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "memo",
            lines: [debit("costs", 500n, { dimensions: ["cc-sales"] }), credit("usd-bank", 500n)],
          }),
        "ACCOUNT_CURRENCY_MISMATCH",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "memo",
            lines: [
              debit("costs", 500n, { dimensions: ["cc-sales"], functionalAmount: 400n }),
              credit("bank", 400n),
            ],
          }),
        "LINE_FUNCTIONAL_AMOUNT_MISMATCH",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "memo",
            lines: [debit("costs", 500n), credit("bank", 500n)],
          }),
        "DIMENSION_RULE_VIOLATED",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "memo",
            lines: [
              debit("costs", 500n, { dimensions: ["cc-sales", "cc-support"] }),
              credit("bank", 500n),
            ],
          }),
        "DIMENSION_REPEATED",
      );
      await ledger.post({
        name: "m1",
        journal: "memo",
        lines: [
          debit("costs", 460n, { dimensions: ["cc-sales"] }),
          credit("usd-bank", 500n, { currency: "USD", functionalAmount: 460n }),
        ],
      });
      await ledger.deactivateAccount("usd-bank");
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "memo",
            lines: [
              debit("costs", 460n, { dimensions: ["cc-sales"] }),
              credit("usd-bank", 500n, { currency: "USD", functionalAmount: 460n }),
            ],
          }),
        "ACCOUNT_INACTIVE",
      );

      expect(await ledger.entries("memo")).toMatchObject([
        {
          lines: [
            { amountMinor: "460", dimensionValueIds: [ledger.id("cc-sales")] },
            { currency: "USD", amountMinor: "500", functionalAmountMinor: "460" },
          ],
        },
      ]);
    }));

  test("posted entries are corrected by exactly one reversal, even on deactivated accounts", () =>
    ledgerScenario(async (ledger) => {
      await ledger.post({ name: "e1", journal: "sales", lines: sale() });
      await ledger.deactivateAccount("revenue");
      await ledger.reverse("r1", "e1");
      await ledger.refuses(() => ledger.reverse("r2", "e1"), "ENTRY_ALREADY_REVERSED");

      const entry = await ledger.entry("sales", 1);
      const reversal = await ledger.entry("sales", 2);
      await ledger.refuses(() => ledger.entry("sales", 3), "ENTRY_NOT_FOUND");
      expect(reversal).toMatchObject({
        entryNumber: 2,
        reverses: { id: entry.id, entryNumber: 1 },
        reversedBy: null,
        sourceDocument: { id: entry.sourceDocument.id },
        lines: [
          { accountId: ledger.id("ar"), side: "credit", amountMinor: "12100" },
          { accountId: ledger.id("revenue"), side: "debit", amountMinor: "12100" },
        ],
      });
      expect(entry.reversedBy).toEqual({ id: reversal.id, entryNumber: 2 });
      expect(await ledger.trialBalance("p1")).toEqual({
        "1300": [12100n, 12100n],
        "8000": [12100n, 12100n],
      });
      // The reversal settles the invoice: nothing is owed any more.
      assert((await ledger.outstanding("e1", 1)) === 0n);
      assert((await ledger.outstanding("r1", 1)) === 0n);
      const [invoice, mirror] = await ledger.openItems("alice-c");
      expect(invoice.allocations).toMatchObject([
        { creditItemId: mirror.id, amountMinor: "12100", reversed: false },
      ]);
    }));

  test("entries record a new source document under the caller's ID, or one an earlier entry recorded", () =>
    ledgerScenario(async (ledger) => {
      const invoice = { type: "new", id: "invoice-1" } as const;
      await ledger.post({ name: "e1", journal: "sales", lines: sale(), source: invoice });
      await ledger.refuses(
        () => ledger.post({ name: "x", journal: "sales", lines: sale(), source: invoice }),
        "SOURCE_DOCUMENT_TAKEN",
      );
      await ledger.refuses(
        () =>
          ledger.post({
            name: "x",
            journal: "sales",
            lines: sale(),
            source: { type: "existing", id: "invoice-2" },
          }),
        "SOURCE_DOCUMENT_NOT_FOUND",
      );
      // Booked again after its reversal, in another journal.
      await ledger.reverse("r1", "e1");
      await ledger.post({
        name: "e2",
        journal: "memo",
        lines: [debit("costs", 500n, { dimensions: ["cc-sales"] }), credit("bank", 500n)],
        source: { type: "existing", id: "invoice-1" },
      });
      const source = {
        id: "invoice-1",
        kind: "manual_journal",
        documentDate: "2026-01-10",
        description: "e1",
      };
      expect((await ledger.entry("sales", 1)).sourceDocument).toEqual(source);
      expect((await ledger.entry("sales", 2)).sourceDocument).toEqual(source);
      expect((await ledger.entry("memo", 1)).sourceDocument).toEqual(source);

      // Creating the same source document twice at once creates it once.
      const twice = await Promise.allSettled(
        ["e3", "e3-again"].map((name) =>
          ledger.post({
            name,
            journal: "sales",
            lines: sale(),
            source: { type: "new", id: "invoice-3" },
          }),
        ),
      );
      expect(twice.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(twice.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "SOURCE_DOCUMENT_TAKEN" },
      });
    }));

  test("a reversal settles only what is still outstanding, leaving payments open on its mirror", () =>
    ledgerScenario(async (ledger) => {
      await ledger.post({ name: "e1", journal: "sales", lines: sale() });
      await ledger.post({
        name: "receipt",
        journal: "cashbook",
        lines: [debit("bank", 5000n), credit("ar", 5000n, { party: "alice-c" })],
      });
      await ledger.allocate({ name: "a1", debit: ["e1", 1], credit: ["receipt", 2], amount: null });
      await ledger.reverse("r1", "e1");

      assert.equal(await ledger.outstanding("e1", 1), 0n);
      // Alice paid 50.00 of an invoice that no longer stands: the books owe it back to her.
      assert.equal(await ledger.outstanding("r1", 1), 5000n);
    }));
});
