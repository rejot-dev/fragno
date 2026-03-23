import {
  getDurableHooksService,
  type AnyFragnoInstantiatedDatabaseFragment,
  type DurableHookRecord,
  type DurableHookStatus,
} from "@fragno-dev/db/durable-hooks";

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

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const resolvePageSize = (pageSize?: number) => {
  if (typeof pageSize !== "number" || !Number.isFinite(pageSize) || !Number.isInteger(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
};

export const serializeHookRecord = (record: DurableHookRecord): DurableHookQueueEntry => ({
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

export const serializeHookRecords = (records: DurableHookRecord[]): DurableHookQueueEntry[] =>
  records.map((record) => serializeHookRecord(record));

export const loadDurableHookQueue = async (
  fragment: AnyFragnoInstantiatedDatabaseFragment,
  options: DurableHookQueueOptions = {},
): Promise<DurableHookQueueResponse> => {
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
};
