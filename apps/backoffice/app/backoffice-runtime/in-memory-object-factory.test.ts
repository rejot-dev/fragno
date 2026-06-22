import { describe, expect, it, assert, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { InMemoryObjectFactory } from "./in-memory-object-factory";
import { createBackofficeObjectRegistry } from "./object-registry";
import type { BackofficeRuntimeServices } from "./runtime-services";

type NamedObjectStub = {
  name: string;
};

const createFactory = () =>
  new InMemoryObjectFactory({
    getRuntimeServices: () => ({}) as BackofficeRuntimeServices,
    objectFactories: {
      UPLOAD: ({ name }) => ({ name }),
    },
  });

describe("InMemoryObjectFactory", () => {
  it("uses canonical user scope names and reuses the same instance for the same address", () => {
    const factory = createFactory();
    const objects = createBackofficeObjectRegistry(factory);

    const first = objects.upload.forUser({ userId: "user-1" }) as unknown as
      | NamedObjectStub
      | undefined;
    const second = objects.upload.forUser({ userId: "user-1" }) as unknown as
      | NamedObjectStub
      | undefined;
    const otherUser = objects.upload.forUser({ userId: "user-2" });

    expect(first).toBe(second);
    assert(first?.name === "UPLOAD:v1:user:user-1");
    expect(otherUser).not.toBe(first);
  });

  it("uses canonical project scope names and keeps project instances separate", () => {
    const factory = createFactory();
    const objects = createBackofficeObjectRegistry(factory);

    const projectOne = objects.upload.forProject({
      orgId: "org-1",
      projectId: "project-1",
    }) as unknown as NamedObjectStub;
    const projectTwo = objects.upload.forProject({
      orgId: "org-1",
      projectId: "project-2",
    }) as unknown as NamedObjectStub;

    assert(projectOne.name === "UPLOAD:v1:project:org-1:project-1");
    assert(projectTwo.name === "UPLOAD:v1:project:org-1:project-2");
    expect(projectTwo).not.toBe(projectOne);
  });

  it("rejects addresses for a different binding", () => {
    const factory = createFactory();

    expect(() =>
      factory.get(
        { name: "PI" },
        {
          binding: "AUTH",
          scope: { kind: "singleton" },
        },
      ),
    ).toThrow("does not match requested binding PI");
  });
});
