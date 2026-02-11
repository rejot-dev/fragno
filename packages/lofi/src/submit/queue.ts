import superjson from "superjson";
import type { LofiAdapter, LofiSubmitCommand } from "../types";

export type SubmitQueue = LofiSubmitCommand[];

export const defaultQueueKey = (endpointName: string) => `${endpointName}::submit-queue`;

export const buildCommandKey = (command: {
  target: { fragment: string; schema: string };
  name: string;
}): string => `${command.target.fragment}::${command.target.schema}::${command.name}`;

export const loadSubmitQueue = async (
  adapter: Pick<LofiAdapter, "getMeta">,
  key: string,
): Promise<SubmitQueue> => {
  const raw = await adapter.getMeta(key);
  if (!raw) {
    return [];
  }

  try {
    const parsed = superjson.deserialize(JSON.parse(raw));
    return Array.isArray(parsed) ? (parsed as SubmitQueue) : [];
  } catch {
    return [];
  }
};

export const storeSubmitQueue = async (
  adapter: Pick<LofiAdapter, "setMeta">,
  key: string,
  queue: SubmitQueue,
): Promise<void> => {
  const serialized = superjson.serialize(queue);
  await adapter.setMeta(key, JSON.stringify(serialized));
};
