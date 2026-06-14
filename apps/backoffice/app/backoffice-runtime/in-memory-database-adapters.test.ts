import { describe, expect, it } from "vitest";

import { createDurableObjectDatabaseAdapterScope } from "./database-adapters";
import { createInMemoryBackofficeDatabaseAdapters } from "./in-memory-database-adapters";

const createState = (id: string) =>
  ({
    id: { toString: () => id },
  }) as DurableObjectState;

describe("createInMemoryBackofficeDatabaseAdapters", () => {
  it("uses Durable Object identity for scoped adapter storage", () => {
    const adapters = createInMemoryBackofficeDatabaseAdapters();

    const firstScope = adapters.forScope(
      createDurableObjectDatabaseAdapterScope(createState("OTP:org-1")),
    );
    const secondScope = adapters.forScope(
      createDurableObjectDatabaseAdapterScope(createState("OTP:org-2")),
    );
    const firstScopeAgain = adapters.forScope(
      createDurableObjectDatabaseAdapterScope(createState("OTP:org-1")),
    );

    const first = firstScope.createAdapter({ kind: "otp" });
    const second = secondScope.createAdapter({ kind: "otp" });
    const firstAgain = firstScopeAgain.createAdapter({ kind: "otp" });

    expect(first).toBe(firstAgain);
    expect(first).not.toBe(second);
  });
});
