import { afterEach, assert, describe, expect, test } from "vitest";

import { backofficeContextScopesEqual } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createWorkflowsTestHarness, createWorkflowsTestRuntime } from "@fragno-dev/workflows/test";

import { buildDatabaseFragmentsTest } from "@fragno-dev/test";

import type { GitHubInstallationOwner } from "@/fragno/github";
import type { GitHubCallRoute } from "@/fragno/github-access";

import {
  defineGitHubInstallationMoveWorkflow,
  GITHUB_INSTALLATION_MOVE_RETRIES,
  GITHUB_INSTALLATION_MOVE_WORKFLOW_NAME,
  type GitHubInstallationMoveParams,
} from "./github-installation-move-workflow";

const from: GitHubInstallationOwner = { kind: "user", userId: "mover", jurisdiction: null };
const to: GitHubInstallationOwner = { kind: "org", orgId: "destination", jurisdiction: null };
const params: GitHubInstallationMoveParams = {
  installation: {
    id: "4242",
    accountId: "7",
    accountLogin: "acme",
    accountType: "Organization",
    htmlUrl: "https://github.com/organizations/acme/settings/installations/4242",
  },
  from,
  to,
  repositories: ["acme/api", "acme/private"],
};
const bound = (linked: string[], missing: string[]) => ({
  moved: true,
  outcome: {
    kind: "bound",
    installation: {
      id: "4242",
      account: "acme",
      url: "https://github.com/organizations/acme/settings/installations/4242",
    },
    synced: true,
    linked,
    missing,
  },
});

type RouteResponse = Awaited<ReturnType<GitHubCallRoute>>;
const ok: RouteResponse = { type: "json", status: 200, data: {} } as RouteResponse;
const readRow: RouteResponse = { type: "json", status: 200, data: { version: 3 } } as RouteResponse;
const refused = (status: number, code: string): RouteResponse =>
  ({ type: "error", status, error: { code, message: `refused: ${code}` } }) as RouteResponse;

/**
 * The router and each workspace's GitHub routes. Routes answer `ok` unless `respond` scripts an
 * answer for a call such as `from read`, `from release`, `to sync`, or `to link acme/api`; every
 * call is kept. `respond` runs as the call arrives, so it can also move the installation.
 */
function fakeGitHub(respond: (call: string, attempt: number) => RouteResponse | undefined) {
  let owner: GitHubInstallationOwner = from;
  const calls: string[] = [];
  const name = (scope: GitHubInstallationOwner) =>
    backofficeContextScopesEqual(scope, from) ? "from" : "to";
  return {
    calls,
    owner: () => owner,
    setOwner: (next: GitHubInstallationOwner) => {
      owner = next;
    },
    dependencies: () => ({
      router: {
        async moveInstallationOwner(
          _installationId: string,
          expected: GitHubInstallationOwner,
          next: GitHubInstallationOwner,
        ) {
          calls.push("move");
          if (backofficeContextScopesEqual(owner, next)) {
            return { ok: true as const };
          }
          if (!backofficeContextScopesEqual(owner, expected)) {
            return {
              ok: false as const,
              code: "INSTALLATION_OWNER_CONFLICT" as const,
              message: "The installation no longer serves the workspace it was moved from.",
            };
          }
          owner = next;
          return { ok: true as const };
        },
        async getInstallationOwner() {
          return owner;
        },
      },
      routesFor: (scope: GitHubInstallationOwner) =>
        (async (_method: string, path: string, options: { pathParams: Record<string, string> }) => {
          const call =
            path === "/installations/:installationId"
              ? `${name(scope)} read`
              : path.endsWith("/release")
                ? `${name(scope)} release`
                : path.endsWith("/sync")
                  ? `${name(scope)} sync`
                  : `${name(scope)} link ${options.pathParams.owner}/${options.pathParams.repo}`;
          calls.push(call);
          return (
            respond(call, calls.filter((made) => made === call).length) ??
            (call.endsWith(" read") ? readRow : ok)
          );
        }) as unknown as GitHubCallRoute,
    }),
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function moveWith(github: ReturnType<typeof fakeGitHub>) {
  const harness = await createWorkflowsTestHarness({
    workflows: {
      MOVE: defineGitHubInstallationMoveWorkflow({
        ownerScope: { kind: "system" },
        dependencies: github.dependencies,
      }),
    },
    adapter: { type: "in-memory" },
    testBuilder: buildDatabaseFragmentsTest(),
    runtime: createWorkflowsTestRuntime({ startAt: 0, seed: 7 }),
    autoTickHooks: false,
  });
  cleanup = () => harness.test.cleanup();
  const instanceId = await harness.createInstance("MOVE", { id: "move-1", params });
  const run = (reason: "create" | "wake" | "retry" = "wake") =>
    harness.runUntilIdle({
      workflowName: GITHUB_INSTALLATION_MOVE_WORKFLOW_NAME,
      instanceId,
      reason,
    });
  /** Waits out every retry delay, a day at a time, until the move stops waiting. */
  const settle = async () => {
    for (let day = 0; day < 10; day += 1) {
      const { status } = await harness.getStatus("MOVE", instanceId);
      if (status !== "waiting" && status !== "active") {
        return;
      }
      harness.clock.advanceBy("1 day");
      await run("retry");
    }
  };
  await run("create");
  return { harness, instanceId, run, settle, status: () => harness.getStatus("MOVE", instanceId) };
}

describe("moving a GitHub installation", () => {
  test("sends webhooks here, releases it there, then syncs and links each repository here", async () => {
    const github = fakeGitHub((call) =>
      call === "to link acme/private" ? refused(404, "REPO_NOT_REACHABLE") : undefined,
    );
    const { status } = await moveWith(github);

    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api"], ["acme/private"]),
    });
    expect(github.calls).toEqual([
      "move",
      "from read",
      "from release",
      "to read",
      "to sync",
      "to link acme/api",
      "to link acme/private",
    ]);
    expect(github.owner()).toEqual(to);
  });

  test("stops without changing anything when the installation was moved meanwhile", async () => {
    const github = fakeGitHub(() => undefined);
    github.setOwner({ kind: "org", orgId: "elsewhere", jurisdiction: null });
    const { status } = await moveWith(github);

    expect(await status()).toMatchObject({
      status: "complete",
      output: {
        moved: false,
        message: "The installation no longer serves the workspace it was moved from.",
      },
    });
    expect(github.calls).toEqual(["move"]);
  });

  test("retries a release the old workspace failed, and goes on only once it is released", async () => {
    const github = fakeGitHub((call, attempt) =>
      call === "from release" && attempt <= 2 ? refused(503, "UNAVAILABLE") : undefined,
    );
    const { status, settle } = await moveWith(github);

    // The first attempt failed and waits for its retry; nothing here changed yet.
    expect(await status()).toMatchObject({ status: "waiting" });
    expect(github.calls).toEqual(["move", "from read", "from release"]);

    await settle();
    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
    // The move ran once; its checkpoint held across the retries.
    expect(github.calls.filter((call) => call === "move")).toHaveLength(1);
    expect(github.calls.filter((call) => call === "from release")).toHaveLength(3);
  });

  test("stops at once when the old workspace refuses the release for good", async () => {
    const github = fakeGitHub((call) =>
      call === "from release" ? refused(403, "FORBIDDEN") : undefined,
    );
    const { status } = await moveWith(github);

    expect(await status()).toMatchObject({
      status: "errored",
      error: {
        name: "NonRetryableError",
        message: "Releasing the installation failed: refused: FORBIDDEN",
      },
    });
    expect(github.calls).toEqual(["move", "from read", "from release"]);
  });

  test("errors once release retries run out, and an operator's step retry finishes the move", async () => {
    let failing = true;
    const github = fakeGitHub((call) =>
      call === "from release" && failing ? refused(500, "BROKEN") : undefined,
    );
    const { harness, instanceId, status, settle, run } = await moveWith(github);
    await settle();

    expect(await status()).toMatchObject({
      status: "errored",
      error: { message: "Releasing the installation failed: refused: BROKEN" },
    });
    expect(github.calls.filter((call) => call === "from release")).toHaveLength(
      GITHUB_INSTALLATION_MOVE_RETRIES.retries.limit + 1,
    );
    // Nothing went on to the new workspace while the old one still reached the repositories.
    assert(!github.calls.some((call) => call.startsWith("to ")));

    failing = false;
    await harness.retryFailedStep("MOVE", instanceId);
    await run("retry");
    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
  });

  test("retries a repository whose link failed for a while, and keeps the ones done", async () => {
    const github = fakeGitHub((call, attempt) =>
      call === "to link acme/private" && attempt === 1 ? refused(502, "GATEWAY") : undefined,
    );
    const { status, settle } = await moveWith(github);
    await settle();

    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
    expect(github.calls).toEqual([
      "move",
      "from read",
      "from release",
      "to read",
      "to sync",
      "to link acme/api",
      "to link acme/private",
      "to link acme/private",
    ]);
  });

  test("syncs again when a webhook's sync wrote first", async () => {
    const github = fakeGitHub((call, attempt) =>
      call === "to sync" && attempt === 1 ? refused(409, "INSTALLATION_SYNC_CONFLICT") : undefined,
    );
    const { status, settle } = await moveWith(github);
    await settle();

    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
    expect(github.calls.filter((call) => call === "to sync")).toHaveLength(2);
  });

  test("does not release the old workspace once a move back made it serve that workspace", async () => {
    const github = fakeGitHub((call) => {
      if (call === "from read") {
        github.setOwner(from);
      }
      return undefined;
    });
    const { status } = await moveWith(github);

    expect(await status()).toMatchObject({
      status: "complete",
      output: {
        moved: false,
        message: "The installation was moved again before it was synced here.",
      },
    });
    expect(github.calls).toEqual(["move", "from read", "to read"]);
  });

  test("does not claim the installation here once another move took it on", async () => {
    const github = fakeGitHub((call) => {
      if (call === "to read") {
        github.setOwner({ kind: "org", orgId: "elsewhere", jurisdiction: null });
      }
      return undefined;
    });
    const { status } = await moveWith(github);

    expect(await status()).toMatchObject({
      status: "complete",
      output: {
        moved: false,
        message: "The installation was moved again before it was synced here.",
      },
    });
    expect(github.calls).toEqual(["move", "from read", "from release", "to read"]);
  });

  test("a restarted runner picks up from the steps that completed", async () => {
    const github = fakeGitHub((call, attempt) =>
      call === "to sync" && attempt === 1 ? refused(503, "UNAVAILABLE") : undefined,
    );
    const { harness, status, settle } = await moveWith(github);
    expect(await status()).toMatchObject({ status: "waiting" });

    await harness.restart();
    await settle();
    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
    expect(github.calls.slice(0, 5)).toEqual([
      "move",
      "from read",
      "from release",
      "to read",
      "to sync",
    ]);
    expect(github.calls.filter((call) => call === "from release")).toHaveLength(1);
  });

  test("a full restart runs every step again and ends the same", async () => {
    const github = fakeGitHub(() => undefined);
    const { harness, instanceId, status, run } = await moveWith(github);
    assert((await status()).status === "complete");

    await harness.restartInstance("MOVE", instanceId);
    await run("create");
    expect(await status()).toMatchObject({
      status: "complete",
      output: bound(["acme/api", "acme/private"], []),
    });
    // The installation already served the new workspace, so moving it again changed nothing.
    expect(github.owner()).toEqual(to);
    expect(github.calls.filter((call) => call === "move")).toHaveLength(2);
  });
});
