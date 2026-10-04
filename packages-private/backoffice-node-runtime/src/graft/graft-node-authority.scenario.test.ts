import { afterAll, assert, beforeAll, expect, test } from "vitest";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createManualNodeRuntimeClock } from "../runtime/node-runtime-clock";
import {
  createRuntimeScenarioStepBuilders,
  runRuntimeScenarioSteps,
  type RuntimeScenarioStep,
  type RuntimeScenarioStepBuilders,
} from "../testing/runtime-scenario";
import { provisionGraftControlDatabase } from "./graft-control-database";
import { GraftControlStore } from "./graft-control-store";
import {
  createSqlitePragmaGraftDatabaseOperations,
  type GraftDatabaseOperations,
} from "./graft-database-operations";
import { GraftNodeAuthority, type GraftNodeLeasePolicy } from "./graft-node-authority";
import type { GraftNodeRuntimeStorage } from "./graft-runtime-storage";

let directory: string;
let configPath: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "graft-node-authority-"));
  const remote = path.join(directory, "remote");
  const cache = path.join(directory, "cache");
  await Promise.all([mkdir(remote), mkdir(cache)]);
  configPath = path.join(directory, "graft.toml");
  await writeFile(
    configPath,
    `data_dir = ${JSON.stringify(cache)}\nmake_default = false\n\n[remote]\ntype = "fs"\nroot = ${JSON.stringify(remote)}\n`,
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const leasePolicy: GraftNodeLeasePolicy = {
  leaseDurationMs: 1_000,
  renewalIntervalMs: 200,
  renewalRetryIntervalMs: 50,
  selfFenceSafetyMarginMs: 100,
  maximumClockSkewMs: 50,
};

type NodeAuthorityScenarioContext = {
  authority: GraftNodeAuthority;
  clock: ReturnType<typeof createManualNodeRuntimeClock>;
  faults: LeaseFaultGraftOperations;
  inspect: GraftControlStore;
  nodeId: string;
};

test("durable renewals advance authority from attempt start rather than response time", async () => {
  await runNodeAuthorityScenario({
    name: "confirmed renewal",
    steps: ({ given, when, then }) => [
      given(
        "a node registered at wall time 1000 with a conservative elapsed deadline",
        ({ authority, inspect, nodeId }) => {
          expect(authority.readStatus()).toMatchObject({
            state: "serving",
            window: { leaseExpiresAtEpochMs: 2_000, selfFenceAtMonotonicMs: 900 },
          });
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
        },
      ),
      when(
        "renewal push consumes 100 milliseconds before confirmation",
        ({ authority, clock, faults }) => {
          clock.advanceBy(200);
          faults.mode = "slow-success";
          authority.tick();
        },
      ),
      then(
        "remote expiry and local deadline advance without gifting response latency",
        ({ authority, inspect, nodeId, clock }) => {
          assert.equal(clock.nowMonotonicMs(), 300);
          expect(authority.readStatus()).toMatchObject({
            state: "serving",
            window: { leaseExpiresAtEpochMs: 2_200, selfFenceAtMonotonicMs: 1_100 },
          });
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_200 });
        },
      ),
    ],
  });
});

test("unconfirmed renewal retains the previous window and retries its exact command", async () => {
  await runNodeAuthorityScenario({
    name: "pre-commit renewal failure",
    steps: ({ given, when, then }) => [
      given("control writes unavailable before remote commit", ({ faults, clock }) => {
        faults.mode = "fail-before-commit";
        clock.advanceBy(200);
      }),
      when("the renewal exhausts semantic command retries", ({ authority }) => {
        authority.tick();
      }),
      then("neither authority nor persisted lease advances", ({ authority, inspect, nodeId }) => {
        expect(authority.readStatus()).toMatchObject({
          state: "serving",
          window: { selfFenceAtMonotonicMs: 900 },
          nextActionAtMonotonicMs: 250,
        });
        expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
      }),
      when("storage recovers for the scheduled retry", ({ faults, clock, authority }) => {
        faults.mode = "normal";
        clock.advanceBy(50);
        authority.tick();
      }),
      then(
        "the original attempt time still determines confirmed authority",
        ({ authority, inspect, nodeId }) => {
          expect(authority.readStatus()).toMatchObject({
            state: "serving",
            window: { selfFenceAtMonotonicMs: 1_100 },
          });
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_200 });
        },
      ),
    ],
  });
});

test("a lost renewal response extends authority only after durable receipt reconciliation", async () => {
  await runNodeAuthorityScenario({
    name: "lost renewal response",
    steps: ({ given, when, then }) => [
      given(
        "remote commit succeeds but its response and subsequent clone reads are unavailable",
        ({ faults, clock }) => {
          faults.mode = "lose-response-and-block-reads";
          clock.advanceBy(200);
        },
      ),
      when("renewal cannot confirm its durable receipt", ({ authority }) => {
        authority.tick();
      }),
      then(
        "the remote lease advanced but local authority did not",
        ({ authority, inspect, nodeId }) => {
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_200 });
          expect(authority.readStatus()).toMatchObject({
            state: "serving",
            window: { selfFenceAtMonotonicMs: 900 },
          });
        },
      ),
      when("reads recover before the prior deadline", ({ authority, clock, faults }) => {
        faults.mode = "normal";
        clock.advanceBy(50);
        authority.tick();
      }),
      then(
        "the original receipt extends authority without another renewal mutation",
        ({ authority, inspect, nodeId, faults }) => {
          expect(authority.readStatus()).toMatchObject({
            state: "serving",
            window: {
              selfFenceAtMonotonicMs: 1_100,
              renewalId: inspect.readNodeLease(nodeId)!.renewalId,
            },
          });
          assert.equal(faults.renewalPushes, 1);
        },
      ),
    ],
  });
});

test("late confirmation cannot revive a process generation even when renewal landed remotely", async () => {
  await runNodeAuthorityScenario({
    name: "late confirmed renewal",
    steps: ({ given, when, then }) => [
      given("a renewal beginning while the old lease is still valid", ({ clock, faults }) => {
        clock.advanceBy(200);
        faults.mode = "late-lost-response";
      }),
      when("the lost response is reconciled after the old monotonic deadline", ({ authority }) => {
        authority.tick();
      }),
      then(
        "remote renewal remains durable but the process is terminally fenced",
        ({ authority, inspect, nodeId }) => {
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_200 });
          expect(authority.readStatus()).toMatchObject({
            state: "fenced",
            reason: { kind: "renewal-confirmed-too-late" },
          });
          expect(() => authority.requireServingWindow()).toThrow(
            "NODE_OBJECT_RUNTIME_NODE_AUTHORITY_FENCED",
          );
        },
      ),
      when(
        "the clock is corrected and storage becomes available",
        ({ authority, faults, clock }) => {
          faults.mode = "normal";
          clock.setEpochMilliseconds(1_000);
          authority.tick();
        },
      ),
      then(
        "the same generation stays fenced without sending a new command",
        ({ authority, faults }) => {
          assert.equal(authority.readStatus().state, "fenced");
          assert.equal(faults.renewalPushes, 1);
        },
      ),
    ],
  });
});

test("registration confirmed after its attempt budget cannot start or reuse the same node", () => {
  const storage = { configPath, controlRemoteLogId: provisionGraftControlDatabase(configPath) };
  const clock = createManualNodeRuntimeClock(1_000);
  const faults = new LeaseFaultGraftOperations(clock);
  faults.mode = "late-registration";
  const store = new GraftControlStore(storage, faults);
  const inspect = new GraftControlStore(storage);
  const identity = {
    nodeId: randomUUID(),
    processGeneration: randomUUID(),
    privateAddress: "late-node.internal:8081",
    applicationOrigin: "http://late-node.internal:8081",
    compatibilityVersion: 1,
  };
  try {
    expect(
      () =>
        new GraftNodeAuthority({
          controlStore: store,
          clock: clock.source,
          identity,
          policy: leasePolicy,
        }),
    ).toThrow("GRAFT_NODE_RUNTIME_REGISTRATION_CONFIRMED_TOO_LATE");
    expect(inspect.readNodeLease(identity.nodeId)).toMatchObject({ expiresAtMs: 2_000 });
    faults.mode = "normal";
    expect(
      () =>
        new GraftNodeAuthority({
          controlStore: store,
          clock: clock.source,
          identity,
          policy: leasePolicy,
        }),
    ).toThrow("GRAFT_NODE_RUNTIME_REGISTRATION_REJECTED");
  } finally {
    store.close();
    inspect.close();
  }
});

test("a renewal cannot preserve its compare-and-set identity while extending expiry", async () => {
  await runNodeAuthorityScenario({
    name: "renewal identity reuse",
    steps: ({ given, when, then }) => [
      given("a durably registered node", ({ inspect, nodeId }) => {
        expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
      }),
      when(
        "a control client tries to reuse the prior renewal identity",
        ({ authority, inspect, nodeId }) => {
          const window = authority.requireServingWindow();
          expect(() =>
            inspect.renewNodeLease({
              commandId: randomUUID(),
              commandCreatedAtMs: 1_100,
              input: {
                nodeId,
                processGeneration: window.processGeneration,
                expectedRenewalId: window.renewalId,
                nextRenewalId: window.renewalId,
                attemptedAtMs: 1_100,
                expiresAtMs: 2_100,
              },
            }),
          ).toThrow("GRAFT_CONTROL_NODE_RENEWAL_ID_NOT_ADVANCED");
        },
      ),
      then("the lease remains unchanged", ({ inspect, nodeId }) => {
        expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
      }),
    ],
  });
});

test("a competing renewal identity terminally rejects the old controller", async () => {
  await runNodeAuthorityScenario({
    name: "unexpected renewal identity",
    steps: ({ given, when, then }) => [
      given(
        "another control client advances the same process lease",
        ({ inspect, nodeId, authority, clock }) => {
          const window = authority.requireServingWindow();
          clock.advanceBy(100);
          inspect.renewNodeLease({
            commandId: randomUUID(),
            commandCreatedAtMs: 1_100,
            input: {
              nodeId,
              processGeneration: window.processGeneration,
              expectedRenewalId: window.renewalId,
              nextRenewalId: "competing-renewal",
              attemptedAtMs: 1_100,
              expiresAtMs: 2_100,
            },
          });
        },
      ),
      when("the old controller tries its compare-and-set renewal", ({ authority, clock }) => {
        clock.advanceBy(100);
        authority.tick();
      }),
      then(
        "the mismatched renewal identity fences without overwriting the winner",
        ({ authority, inspect, nodeId }) => {
          expect(authority.readStatus()).toMatchObject({
            state: "fenced",
            reason: { kind: "renewal-rejected", outcome: "renewal-id-mismatch" },
          });
          expect(inspect.readNodeLease(nodeId)).toMatchObject({
            renewalId: "competing-renewal",
            expiresAtMs: 2_100,
          });
        },
      ),
    ],
  });
});

test("unavailable renewal reaches the prior deadline without granting speculative authority", async () => {
  await runNodeAuthorityScenario({
    name: "renewal unavailable through expiry",
    steps: ({ given, when, then }) => [
      given("control storage unavailable", ({ faults, clock }) => {
        faults.mode = "fail-before-commit";
        clock.advanceBy(200);
      }),
      when("renewal fails and elapsed time reaches the old deadline", ({ authority, clock }) => {
        authority.tick();
        clock.advanceMonotonicBy(700);
        authority.tick();
      }),
      then(
        "the process self-fences without advancing its durable lease",
        ({ authority, inspect, nodeId }) => {
          expect(authority.readStatus()).toMatchObject({
            state: "fenced",
            reason: { kind: "authority-deadline-exhausted" },
          });
          expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
        },
      ),
    ],
  });
});

test.each([
  {
    name: "backward",
    epochMs: 500,
    reason: { kind: "renewal-rejected", outcome: "expiry-not-advanced" },
  },
  { name: "forward", epochMs: 3_000, reason: { kind: "authority-deadline-exhausted" } },
])(
  "a $name wall-clock correction cannot invent continuously valid authority",
  async ({ name, epochMs, reason }) => {
    await runNodeAuthorityScenario({
      name: `${name} wall-clock correction`,
      steps: ({ given, when, then }) => [
        given("a wall-clock correction independent of elapsed time", ({ clock }) => {
          clock.advanceMonotonicBy(200);
          clock.setEpochMilliseconds(epochMs);
        }),
        when(
          "renewal evaluates the corrected wall time against the persisted lease",
          ({ authority }) => {
            authority.tick();
          },
        ),
        then(
          "the semantic rejection terminally fences the process",
          ({ authority, inspect, nodeId }) => {
            expect(authority.readStatus()).toMatchObject({ state: "fenced", reason });
            expect(inspect.readNodeLease(nodeId)).toMatchObject({ expiresAtMs: 2_000 });
          },
        ),
      ],
    });
  },
);

async function runNodeAuthorityScenario(definition: {
  name: string;
  steps(
    builders: RuntimeScenarioStepBuilders<NodeAuthorityScenarioContext>,
  ): readonly RuntimeScenarioStep<NodeAuthorityScenarioContext>[];
}): Promise<void> {
  const storage: GraftNodeRuntimeStorage = {
    configPath,
    controlRemoteLogId: provisionGraftControlDatabase(configPath),
  };
  const clock = createManualNodeRuntimeClock(1_000);
  const nodeId = randomUUID();
  const faults = new LeaseFaultGraftOperations(clock);
  const store = new GraftControlStore(storage, faults);
  const inspect = new GraftControlStore(storage);
  let authority: GraftNodeAuthority | null = null;
  try {
    authority = new GraftNodeAuthority({
      controlStore: store,
      clock: clock.source,
      identity: {
        nodeId,
        processGeneration: randomUUID(),
        privateAddress: "node.internal:8081",
        applicationOrigin: "http://node.internal:8081",
        compatibilityVersion: 1,
      },
      policy: leasePolicy,
    });
    faults.renewalPushes = 0;
    await runRuntimeScenarioSteps({
      name: definition.name,
      context: { authority, clock, faults, inspect, nodeId },
      steps: definition.steps(
        createRuntimeScenarioStepBuilders("GRAFT_NODE_AUTHORITY_CONCURRENT_STEP_FAILED"),
      ),
      stepFailurePrefix: "GRAFT_NODE_AUTHORITY_STEP_FAILED",
    });
  } finally {
    authority?.close();
    store.close();
    inspect.close();
  }
}

class LeaseFaultGraftOperations implements GraftDatabaseOperations {
  mode:
    | "normal"
    | "slow-success"
    | "late-registration"
    | "fail-before-commit"
    | "lose-response-and-block-reads"
    | "late-lost-response" = "normal";
  renewalPushes = 0;
  readonly #operations = createSqlitePragmaGraftDatabaseOperations();
  readonly #clock: ReturnType<typeof createManualNodeRuntimeClock>;
  #responseLost = false;

  constructor(clock: ReturnType<typeof createManualNodeRuntimeClock>) {
    this.#clock = clock;
  }

  clone(database: DatabaseSync, remoteLogId: string): void {
    if (this.mode === "lose-response-and-block-reads" && this.#responseLost) {
      throw new Error("EXPECTED_RENEWAL_RECEIPT_READ_UNAVAILABLE");
    }
    this.#operations.clone(database, remoteLogId);
  }

  pull(database: DatabaseSync): void {
    this.#operations.pull(database);
  }
  readRemoteLogId(database: DatabaseSync): string {
    return this.#operations.readRemoteLogId(database);
  }

  push(database: DatabaseSync): void {
    if (this.mode === "fail-before-commit") {
      throw new Error("EXPECTED_RENEWAL_FAILURE_BEFORE_COMMIT");
    }
    this.renewalPushes += 1;
    this.#operations.push(database);
    if (this.mode === "slow-success") {
      this.#clock.advanceBy(100);
    }
    if (this.mode === "late-registration") {
      this.#clock.advanceMonotonicBy(900);
    }
    if (this.mode === "late-lost-response") {
      this.#clock.advanceMonotonicBy(700);
      throw new Error("EXPECTED_LATE_RENEWAL_RESPONSE_LOST");
    }
    if (this.mode === "lose-response-and-block-reads") {
      this.#responseLost = true;
      throw new Error("EXPECTED_RENEWAL_RESPONSE_LOST");
    }
  }
}
