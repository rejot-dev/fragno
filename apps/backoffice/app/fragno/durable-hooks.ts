import {
  getDurableHooksService,
  type AnyFragnoInstantiatedDatabaseFragment,
  type DurableHookRecord,
  type DurableHookStatus,
} from "@fragno-dev/db/durable-hooks";
import type { FragnoId } from "@fragno-dev/db/schema";

export type DurableHookQueueEntry = {
  id: string;
  hookName: string;
  status: DurableHookStatus;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string | null;
  error: string | null;
  payload: DurableHookPayload;
};

export type DurableHookQueueResponse = {
  configured: boolean;
  hooksEnabled: boolean;
  namespace: string | null;
  items: DurableHookQueueEntry[];
  cursor?: string;
  hasNextPage: boolean;
};

export type DurableHookPayload = Rpc.Serializable<unknown>;

export type DurableHookQueueOptions = {
  cursor?: string;
  pageSize?: number;
};

export type DurableHookRepository<
  TOptions extends DurableHookQueueOptions = DurableHookQueueOptions,
> = {
  getHookQueue(options?: TOptions): Promise<DurableHookQueueResponse>;
  getHook(hookId: string, options?: TOptions): Promise<DurableHookQueueEntry | null>;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const resolvePageSize = (pageSize?: number) => {
  if (typeof pageSize !== "number" || !Number.isFinite(pageSize) || !Number.isInteger(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
};

const serializeHookRecord = (record: DurableHookRecord): DurableHookQueueEntry => ({
  id: String(record.id),
  hookName: record.hookName,
  status: record.status,
  attempts: record.attempts,
  maxAttempts: record.maxAttempts,
  lastAttemptAt: record.lastAttemptAt ? record.lastAttemptAt.toISOString() : null,
  nextRetryAt: record.nextRetryAt ? record.nextRetryAt.toISOString() : null,
  createdAt: record.createdAt ? record.createdAt.toISOString() : null,
  error: record.error ?? null,
  payload: record.payload as DurableHookPayload,
});

const serializeHookRecords = (records: DurableHookRecord[]): DurableHookQueueEntry[] =>
  records.map((record) => serializeHookRecord(record));

/** Reads one cursor page from a configured fragment's durable hook queue. */
export async function loadDurableHookQueue(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
  options: DurableHookQueueOptions = {},
): Promise<DurableHookQueueResponse> {
  const { hookService, hooksEnabled, namespace } = getDurableHooksService(fragment);

  if (!hooksEnabled) {
    return {
      configured: true,
      hooksEnabled: false,
      namespace,
      items: [],
      cursor: undefined,
      hasNextPage: false,
    };
  }

  const pageSize = resolvePageSize(options.pageSize);
  const page = await fragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(
        () =>
          [
            hookService.getHooksByNamespacePage(namespace, {
              cursor: options.cursor,
              pageSize,
            }),
          ] as const,
      )
      .transform(({ serviceResult: [result] }) => result)
      .execute();
  });

  return {
    configured: true,
    hooksEnabled: true,
    namespace,
    items: serializeHookRecords(page.items),
    cursor: page.cursor?.encode(),
    hasNextPage: page.hasNextPage,
  };
}

/** Reads one durable hook only when it belongs to the configured fragment namespace. */
export async function loadDurableHook(
  fragment: AnyFragnoInstantiatedDatabaseFragment,
  hookId: string,
): Promise<DurableHookQueueEntry | null> {
  const { hookService, hooksEnabled, namespace } = getDurableHooksService(fragment);

  if (!hooksEnabled) {
    return null;
  }

  const record = await fragment.inContext(async function () {
    return await this.handlerTx()
      .withServiceCalls(() => [hookService.getHookById(hookId as unknown as FragnoId)] as const)
      .transform(({ serviceResult: [result] }) => result)
      .execute();
  });

  if (!record || record.namespace !== namespace) {
    return null;
  }

  return serializeHookRecord(record);
}

/** Builds the finite durable hook queue response for an unconfigured object. */
export function createUnconfiguredDurableHookQueueResponse(): DurableHookQueueResponse {
  return {
    configured: false,
    hooksEnabled: false,
    namespace: null,
    items: [],
    cursor: undefined,
    hasNextPage: false,
  };
}
