import { createWorkflowsClient } from "@fragno-dev/workflows/react";

import { getStoredShard } from "~/sharding";

const shardAwareFetch: typeof fetch = async (input, init) => {
  const shard = getStoredShard();
  const headers = new Headers(init?.headers ?? {});

  if (shard) {
    headers.set("x-fragno-shard", shard);
  }

  return fetch(input, { ...init, headers });
};

export const workflowsClient = createWorkflowsClient({
  fetcherConfig: {
    type: "function",
    fetcher: shardAwareFetch,
  },
});
