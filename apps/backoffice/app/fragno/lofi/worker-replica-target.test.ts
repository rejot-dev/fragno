import { describe, expect, test } from "vitest";

import { readWorkerReplicaName, workerReplicaName } from "./worker-replica-target";

describe("worker replica names", () => {
  test("name the backend's URL and identity", () => {
    const target = { baseUrl: "/api/upload-scoped/org/acme", adapterIdentity: "do:abc" };
    const streams = { pollsOnceCaughtUp: false };
    expect(readWorkerReplicaName(workerReplicaName(target, streams))).toEqual(target);
    expect(workerReplicaName(target, streams)).not.toEqual(
      workerReplicaName({ ...target, adapterIdentity: "do:def" }, streams),
    );
  });

  test("name whether the replica polls once caught up", () => {
    const target = { baseUrl: "/api/automations/org/acme", adapterIdentity: "do:abc" };
    expect(readWorkerReplicaName(workerReplicaName(target, { pollsOnceCaughtUp: true }))).toEqual({
      ...target,
      pollOnceCaughtUp: { catchUpTurns: 2, intervalMs: 2_000 },
    });
  });

  test("refuse a name without the identity", () => {
    expect(() => readWorkerReplicaName(JSON.stringify(["/api/upload-scoped/org/acme"]))).toThrow(
      "must name its backend",
    );
  });
});
