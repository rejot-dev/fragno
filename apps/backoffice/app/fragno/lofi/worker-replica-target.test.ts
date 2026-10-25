import { describe, expect, test } from "vitest";

import { readWorkerReplicaName, workerReplicaName } from "./worker-replica-target";

describe("worker replica names", () => {
  test("name the backend's URL and identity", () => {
    const target = { baseUrl: "/api/upload-scoped/org/acme", adapterIdentity: "do:abc" };
    expect(readWorkerReplicaName(workerReplicaName(target))).toEqual(target);
    expect(workerReplicaName(target)).not.toEqual(
      workerReplicaName({ ...target, adapterIdentity: "do:def" }),
    );
  });

  test("refuse a name without the identity", () => {
    expect(() => readWorkerReplicaName(JSON.stringify(["/api/upload-scoped/org/acme"]))).toThrow(
      "must name its backend",
    );
  });
});
