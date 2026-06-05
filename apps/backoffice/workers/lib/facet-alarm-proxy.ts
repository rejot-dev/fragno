export type FacetAlarmProxyFacet = Fetcher;

export type FacetAlarmProxy = {
  sync(facetName: string, facet: FacetAlarmProxyFacet): Promise<void>;
  processDue(): Promise<void>;
  reschedule(): Promise<void>;
};

export type CreateFacetAlarmProxyOptions = {
  state: DurableObjectState;
  storagePrefix: string;
  alarmStateUrl: string;
  getFacet: (facetName: string) => Promise<FacetAlarmProxyFacet> | FacetAlarmProxyFacet;
  deliverAlarm: (input: { facetName: string; facet: FacetAlarmProxyFacet }) => Promise<void>;
  onDeliveryError?: (input: { facetName: string; error: unknown }) => void;
};

const storageKeyFor = (prefix: string, facetName: string) => `${prefix}${facetName}`;

const toAlarmTime = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  return null;
};

export const createFacetAlarmProxy = ({
  state,
  storagePrefix,
  alarmStateUrl,
  getFacet,
  deliverAlarm,
  onDeliveryError,
}: CreateFacetAlarmProxyOptions): FacetAlarmProxy => {
  const set = async (facetName: string, alarmTime: number) => {
    await state.storage.put(storageKeyFor(storagePrefix, facetName), alarmTime);
    await reschedule();
  };

  const remove = async (facetName: string) => {
    await state.storage.delete(storageKeyFor(storagePrefix, facetName));
    await reschedule();
  };

  const reschedule = async () => {
    const alarms = await state.storage.list<number>({ prefix: storagePrefix });
    let nextAlarm: number | undefined;
    for (const alarmTime of alarms.values()) {
      if (nextAlarm === undefined || alarmTime < nextAlarm) {
        nextAlarm = alarmTime;
      }
    }

    if (nextAlarm === undefined) {
      return;
    }

    const currentAlarm = await state.storage.getAlarm();
    if (currentAlarm == null || nextAlarm < currentAlarm) {
      await state.storage.setAlarm(nextAlarm);
    }
  };

  const sync = async (facetName: string, facet: FacetAlarmProxyFacet) => {
    const response = await facet.fetch(new Request(alarmStateUrl));
    if (!response.ok) {
      throw new Error(`Could not read proxied facet alarm state: ${await response.text()}`);
    }

    const alarmState = (await response.json()) as { alarmTime?: unknown };
    const alarmTime = toAlarmTime(alarmState.alarmTime);
    if (alarmTime == null) {
      await remove(facetName);
      return;
    }

    await set(facetName, alarmTime);
  };

  const processDue = async () => {
    const now = Date.now();
    const alarms = await state.storage.list<number>({ prefix: storagePrefix });
    for (const [key, alarmTime] of alarms) {
      if (alarmTime > now) {
        continue;
      }

      const facetName = key.slice(storagePrefix.length);
      await state.storage.delete(key);
      try {
        const facet = await getFacet(facetName);
        await deliverAlarm({ facetName, facet });
        await sync(facetName, facet);
      } catch (error) {
        onDeliveryError?.({ facetName, error });
      }
    }

    await reschedule();
  };

  return { sync, processDue, reschedule };
};
