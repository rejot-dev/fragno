import SQLite from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { instantiate } from "@fragno-dev/core";
import {
  prepareHookMutations,
  processHooks,
  type HooksMap,
  type HookContext,
  type HookHandlerTx,
} from "./hooks";
import { internalFragmentDef, internalSchema } from "../fragments/internal-fragment";
import { getRegistryForAdapterSync } from "../internal/adapter-registry";
import type { FragnoPublicConfigWithDatabase } from "../db-fragment-definition-builder";
import { SqlAdapter } from "../adapters/generic-sql/generic-sql-adapter";
import { BetterSQLite3DriverConfig } from "../adapters/generic-sql/driver-config";
import { ExponentialBackoffRetryPolicy, NoRetryPolicy } from "../query/unit-of-work/retry-policy";
import type { FragnoId } from "../schema/create";

type OptionsWithAdapter = FragnoPublicConfigWithDatabase & {
  databaseAdapter: SqlAdapter;
};

describe("Hook System", () => {
  const handlerTx = (() => {
    throw new Error("handlerTx not configured for hooks test");
  }) as HookHandlerTx;
  let sqliteDatabase: SQLite.Database;
  let adapter: SqlAdapter;
  let internalFragment: ReturnType<typeof instantiateFragment>;

  function instantiateFragment(options: OptionsWithAdapter) {
    return instantiate(internalFragmentDef)
      .withConfig({ registry: getRegistryForAdapterSync(options.databaseAdapter) })
      .withOptions(options)
      .build();
  }

  beforeAll(async () => {
    sqliteDatabase = new SQLite(":memory:");

    const dialect = new SqliteDialect({
      database: sqliteDatabase,
    });

    adapter = new SqlAdapter({
      dialect,
      driverConfig: new BetterSQLite3DriverConfig(),
    });

    {
      const migrations = adapter.prepareMigrations(internalSchema, null);
      await migrations.executeWithDriver(adapter.driver, 0);
    }

    const options: OptionsWithAdapter = {
      databaseAdapter: adapter,
      databaseNamespace: null,
    };

    internalFragment = instantiateFragment(options);

    return async () => {
      await adapter.close();
    };
  }, 12000);

  describe("prepareHookMutations", () => {
    it("should create hook records for triggered hooks", async () => {
      const namespace = "test-namespace";
      const hooks: HooksMap = {
        onTest: vi.fn(),
      };
      const onSuccess = vi.fn();
      const onBeforeMutate = vi.fn();

      await internalFragment.inContext(async function () {
        await this.handlerTx({
          onAfterMutate: onSuccess,
          onBeforeMutate,
        })
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema, hooks);

            // Trigger a hook
            uow.triggerHook("onTest", { data: "test" });

            // Prepare hook mutations
            prepareHookMutations(uow, {
              hooks,
              namespace,
              internalFragment,
              handlerTx,
              defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5 }),
            });
          })
          .execute();
      });

      // Verify callbacks were executed
      expect(onSuccess).toHaveBeenCalledOnce();
      expect(onBeforeMutate).toHaveBeenCalledOnce();

      // Verify hook was created
      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getPendingHookEvents(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        hookName: "onTest",
        payload: { data: "test" },
        attempts: 0,
        maxAttempts: 5,
      });
    });

    it("should set maxAttempts to 1 when retry policy does not retry", async () => {
      const namespace = "test-no-retry";
      const hooks: HooksMap = {
        onNoRetry: vi.fn(),
      };

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema, hooks);

            uow.triggerHook("onNoRetry", { data: "test" });

            prepareHookMutations(uow, {
              hooks,
              namespace,
              internalFragment,
              handlerTx,
              defaultRetryPolicy: new NoRetryPolicy(),
            });
          })
          .execute();
      });

      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getPendingHookEvents(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.maxAttempts).toBe(1);
    });

    it("should use custom retry policy from trigger options", async () => {
      const namespace = "test-custom-retry";
      const hooks: HooksMap = {
        onCustomRetry: vi.fn(),
      };

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema, hooks);

            uow.triggerHook(
              "onCustomRetry",
              { data: "test" },
              {
                retryPolicy: new NoRetryPolicy(),
              },
            );

            prepareHookMutations(uow, {
              hooks,
              namespace,
              internalFragment,
              handlerTx,
              defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 10 }),
            });
          })
          .execute();
      });

      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getPendingHookEvents(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(events[0]?.maxAttempts).toBe(1);
    });

    it("should set nextRetryAt when processAt is in the future", async () => {
      const namespace = "test-process-at-future";
      const hooks: HooksMap = {
        onScheduled: vi.fn(),
      };
      const futureTime = new Date(Date.now() + 60000);

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema, hooks);

            uow.triggerHook("onScheduled", { data: "test" }, { processAt: futureTime });

            prepareHookMutations(uow, {
              hooks,
              namespace,
              internalFragment,
              handlerTx,
              defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5 }),
            });
          })
          .execute();
      });

      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.nextRetryAt).toBeInstanceOf(Date);
      expect(events[0]?.nextRetryAt?.getTime()).toBe(futureTime.getTime());
    });

    it("should keep processAt in the past while remaining immediately eligible", async () => {
      const namespace = "test-process-at-past";
      const hooks: HooksMap = {
        onImmediate: vi.fn(),
      };
      const pastTime = new Date(Date.now() - 60000);

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema, hooks);

            uow.triggerHook("onImmediate", { data: "test" }, { processAt: pastTime });

            prepareHookMutations(uow, {
              hooks,
              namespace,
              internalFragment,
              handlerTx,
              defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 5 }),
            });
          })
          .execute();
      });

      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.nextRetryAt).toBeInstanceOf(Date);
      expect(events[0]?.nextRetryAt?.getTime()).toBe(pastTime.getTime());
    });
  });

  describe("processHooks", () => {
    it("should execute hooks and mark them as completed", async () => {
      const namespace = "test-success";
      const hookFn = vi.fn();
      const hooks: HooksMap = {
        onSuccess: hookFn,
      };

      let eventId: FragnoId;

      // Create a pending hook event
      await internalFragment.inContext(async function () {
        const createdId = await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            return uow.create("fragno_hooks", {
              namespace,
              hookName: "onSuccess",
              payload: { email: "test@example.com" },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "test-nonce",
            });
          })
          .execute();
        eventId = createdId;
      });

      // Process hooks
      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 }),
      });

      // Verify hook was called
      expect(hookFn).toHaveBeenCalledOnce();
      expect(hookFn).toHaveBeenCalledWith({ email: "test@example.com" });

      // Verify hook context (this)
      const hookContext = hookFn.mock.contexts[0] as HookContext;
      expect(hookContext.idempotencyKey).toBe("test-nonce");

      // Verify event was marked as completed
      const result = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHookById(eventId)] as const,
          )
          .transform(({ serviceResult: [event] }) => event)
          .execute();
      });

      expect(result?.status).toBe("completed");
      expect(result?.lastAttemptAt).toBeInstanceOf(Date);
    });

    it("should mark failed hooks for retry", async () => {
      const namespace = "test-failure";
      const hookFn = vi.fn().mockRejectedValue(new Error("Hook failed"));
      const hooks: HooksMap = {
        onFailure: hookFn,
      };

      let eventId: FragnoId;

      await internalFragment.inContext(async function () {
        const createdId = await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            return uow.create("fragno_hooks", {
              namespace,
              hookName: "onFailure",
              payload: { data: "test" },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "test-nonce",
            });
          })
          .execute();
        eventId = createdId;
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 }),
      });

      expect(hookFn).toHaveBeenCalledOnce();

      const result = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHookById(eventId)] as const,
          )
          .transform(({ serviceResult: [event] }) => event)
          .execute();
      });

      expect(result?.status).toBe("pending");
      expect(result?.attempts).toBe(1);
      expect(result?.error).toBe("Hook failed");
      expect(result?.nextRetryAt).toBeInstanceOf(Date);
    });

    it("should mark failed hooks as permanently failed when max retries exceeded", async () => {
      const namespace = "test-max-retries";
      const hookFn = vi.fn().mockRejectedValue(new Error("Permanent failure"));
      const hooks: HooksMap = {
        onMaxRetries: hookFn,
      };

      let eventId: FragnoId;

      await internalFragment.inContext(async function () {
        const createdId = await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            return uow.create("fragno_hooks", {
              namespace,
              hookName: "onMaxRetries",
              payload: { data: "test" },
              status: "pending",
              attempts: 0,
              maxAttempts: 1,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "test-nonce",
            });
          })
          .execute();
        eventId = createdId;
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new NoRetryPolicy(),
      });

      const result = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHookById(eventId)] as const,
          )
          .transform(({ serviceResult: [event] }) => event)
          .execute();
      });

      expect(result?.status).toBe("failed");
      expect(result?.attempts).toBe(1);
      expect(result?.error).toBe("Permanent failure");
    });

    it("should handle missing hooks gracefully", async () => {
      const namespace = "test-missing-hook";
      const hooks: HooksMap = {
        onExisting: vi.fn(),
      };

      let eventId: FragnoId;

      await internalFragment.inContext(async function () {
        const createdId = await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            return uow.create("fragno_hooks", {
              namespace,
              hookName: "onMissing",
              payload: { data: "test" },
              status: "pending",
              attempts: 0,
              maxAttempts: 1,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "test-nonce",
            });
          })
          .execute();
        eventId = createdId;
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new NoRetryPolicy(),
      });

      const result = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHookById(eventId)] as const,
          )
          .transform(({ serviceResult: [event] }) => event)
          .execute();
      });

      expect(result?.status).toBe("failed");
      expect(result?.error).toBe("Hook 'onMissing' not found in hooks map");
    });

    it("should re-queue stuck processing hooks and call the handler", async () => {
      const namespace = "test-stuck-processing";
      const hookFn = vi.fn();
      const hooks: HooksMap = {
        onStuck: hookFn,
      };
      const onStuckProcessingHooks = vi.fn();

      let eventId: FragnoId;

      await internalFragment.inContext(async function () {
        const createdId = await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            return uow.create("fragno_hooks", {
              namespace,
              hookName: "onStuck",
              payload: { ok: true },
              status: "processing",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: new Date(Date.now() - 20 * 60_000),
              nextRetryAt: null,
              error: null,
              nonce: "test-nonce",
            });
          })
          .execute();
        eventId = createdId;
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        stuckProcessingTimeoutMinutes: 1,
        onStuckProcessingHooks,
      });

      expect(hookFn).toHaveBeenCalledOnce();
      expect(onStuckProcessingHooks).toHaveBeenCalledOnce();
      expect(onStuckProcessingHooks).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace,
          timeoutMinutes: 1,
          events: [expect.objectContaining({ hookName: "onStuck" })],
        }),
      );

      const result = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHookById(eventId)] as const,
          )
          .transform(({ serviceResult: [event] }) => event)
          .execute();
      });

      expect(result?.status).toBe("completed");
    });

    it("should process multiple hooks in parallel", async () => {
      const namespace = "test-parallel";
      const hook1 = vi.fn();
      const hook2 = vi.fn();
      const hook3 = vi.fn();
      const hooks: HooksMap = {
        onHook1: hook1,
        onHook2: hook2,
        onHook3: hook3,
      };

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook1",
              payload: { id: 1 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-1",
            });
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook2",
              payload: { id: 2 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-2",
            });
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook3",
              payload: { id: 3 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-3",
            });
          })
          .execute();
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 }),
      });

      expect(hook1).toHaveBeenCalledWith({ id: 1 });
      expect(hook2).toHaveBeenCalledWith({ id: 2 });
      expect(hook3).toHaveBeenCalledWith({ id: 3 });

      // Verify all were marked as completed
      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      const completed = events.filter((e) => e.status === "completed");
      expect(completed).toHaveLength(3);
    });

    it("should continue processing other hooks when one fails", async () => {
      const namespace = "test-partial-failure";
      const hook1 = vi.fn();
      const hook2 = vi.fn().mockRejectedValue(new Error("Hook 2 failed"));
      const hook3 = vi.fn();
      const hooks: HooksMap = {
        onHook1: hook1,
        onHook2: hook2,
        onHook3: hook3,
      };

      await internalFragment.inContext(async function () {
        await this.handlerTx()
          .mutate(({ forSchema }) => {
            const uow = forSchema(internalSchema);
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook1",
              payload: { id: 1 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-1",
            });
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook2",
              payload: { id: 2 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-2",
            });
            uow.create("fragno_hooks", {
              namespace,
              hookName: "onHook3",
              payload: { id: 3 },
              status: "pending",
              attempts: 0,
              maxAttempts: 5,
              lastAttemptAt: null,
              nextRetryAt: null,
              error: null,
              nonce: "nonce-3",
            });
          })
          .execute();
      });

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 }),
      });

      expect(hook1).toHaveBeenCalledOnce();
      expect(hook2).toHaveBeenCalledOnce();
      expect(hook3).toHaveBeenCalledOnce();

      // Verify hook1 and hook3 were completed, hook2 was marked for retry
      const events = await internalFragment.inContext(async function () {
        return await this.handlerTx()
          .withServiceCalls(
            () => [internalFragment.services.hookService.getHooksByNamespace(namespace)] as const,
          )
          .transform(({ serviceResult: [result] }) => result)
          .execute();
      });

      const completed = events.filter((e) => e.status === "completed");
      const pending = events.filter((e) => e.status === "pending" && e.attempts === 1);

      expect(completed).toHaveLength(2);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.error).toBe("Hook 2 failed");
    });

    it("should do nothing when no pending events exist", async () => {
      const namespace = "test-no-events";
      const hookFn = vi.fn();
      const hooks: HooksMap = {
        onTest: hookFn,
      };

      await processHooks({
        hooks,
        namespace,
        internalFragment,
        handlerTx,
        defaultRetryPolicy: new ExponentialBackoffRetryPolicy({ maxRetries: 3 }),
      });

      expect(hookFn).not.toHaveBeenCalled();
    });
  });
});
