import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { enterSpan, setAttribute } = vi.hoisted(() => ({
  setAttribute: vi.fn(),
  enterSpan: vi.fn((_name: string, callback: (span: unknown) => unknown) =>
    callback({ setAttribute: vi.fn() }),
  ),
}));

vi.mock("cloudflare:workers", () => ({ tracing: { enterSpan } }));

import { cloudflareDatabaseTransactionInstrumentation } from "./cloudflare-database-transaction-instrumentation";

describe("cloudflareDatabaseTransactionInstrumentation", () => {
  beforeEach(() => {
    enterSpan.mockReset();
    setAttribute.mockReset();
    enterSpan.mockImplementation((_name: string, callback: (span: unknown) => unknown) =>
      callback({ setAttribute }),
    );
  });

  test("creates named transaction and callback spans with searchable attributes", () => {
    const execute = vi.fn(() => "done");

    const result = cloudflareDatabaseTransactionInstrumentation.run(
      {
        fragmentName: "billing",
        transactionKind: "service",
        transactionName: "billing.recordEvent",
        idempotencyKey: "uow-123",
        callback: "mutate",
      },
      execute,
    );

    expect(result).toBe("done");
    expect(execute).toHaveBeenCalledOnce();
    expect(enterSpan).toHaveBeenCalledWith(
      "fragno.db.service.billing.recordEvent.mutate",
      expect.any(Function),
    );
    expect(setAttribute.mock.calls).toEqual([
      ["fragno.db.transaction.kind", "service"],
      ["fragno.db.transaction.name", "billing.recordEvent"],
      ["fragno.db.transaction.idempotency_key", "uow-123"],
      ["fragno.db.fragment.name", "billing"],
      ["fragno.db.transaction.callback", "mutate"],
    ]);
  });

  test.each(["serviceCalls", "transformRetrieve"] as const)(
    "uses the callback name directly for %s spans",
    (callback) => {
      cloudflareDatabaseTransactionInstrumentation.run(
        {
          transactionKind: "handler",
          transactionName: "billing.recordEvent",
          callback,
        },
        () => undefined,
      );

      expect(enterSpan).toHaveBeenCalledWith(
        `fragno.db.handler.billing.recordEvent.${callback}`,
        expect.any(Function),
      );
    },
  );

  test("does not emit spans for unnamed transactions", () => {
    const execute = vi.fn(() => "done");

    assert.equal(
      cloudflareDatabaseTransactionInstrumentation.run(
        { fragmentName: "billing", transactionKind: "handler" },
        execute,
      ),
      "done",
    );
    expect(enterSpan).not.toHaveBeenCalled();
  });

  test("executes without tracing when enterSpan skips its callback", () => {
    const execute = vi.fn(() => "done");
    enterSpan.mockImplementationOnce(() => undefined);

    assert.equal(
      cloudflareDatabaseTransactionInstrumentation.run(
        { transactionKind: "handler", transactionName: "billing.recordEvent" },
        execute,
      ),
      "done",
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});
