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
        requestSource: "route",
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
      ["fragno.db.request.source", "route"],
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
          requestSource: "route",
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
        { fragmentName: "billing", transactionKind: "handler", requestSource: "route" },
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
        {
          transactionKind: "handler",
          requestSource: "route",
          transactionName: "billing.recordEvent",
        },
        execute,
      ),
      "done",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  test("executes stream transactions without entering the ambient foreground trace", () => {
    const execute = vi.fn(() => "done");

    assert(
      cloudflareDatabaseTransactionInstrumentation.run(
        {
          fragmentName: "internal",
          transactionKind: "handler",
          requestSource: "stream",
          transactionName: "internal.outbox.list",
        },
        execute,
      ) === "done",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(enterSpan).not.toHaveBeenCalled();
  });

  test("does not let an overlapping stream transaction contaminate a foreground span", async () => {
    let finishStream!: () => void;
    const streamExecution = cloudflareDatabaseTransactionInstrumentation.run(
      {
        transactionKind: "handler",
        requestSource: "stream",
        transactionName: "internal.outbox.list",
      },
      () =>
        new Promise<void>((resolve) => {
          finishStream = resolve;
        }),
    );

    assert(
      cloudflareDatabaseTransactionInstrumentation.run(
        {
          transactionKind: "handler",
          requestSource: "route",
          transactionName: "files.load",
        },
        () => "foreground",
      ) === "foreground",
    );

    expect(enterSpan).toHaveBeenCalledTimes(1);
    expect(enterSpan).toHaveBeenCalledWith("fragno.db.handler.files.load", expect.any(Function));
    finishStream();
    await streamExecution;
  });
});
