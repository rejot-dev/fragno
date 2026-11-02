import { createHash } from "node:crypto";

import {
  backofficeRootOwnerSchema,
  backofficeScopePathSegment,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createRouteCaller } from "@fragno-dev/core/api";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { GitHubWebhookRouterCommands } from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { GitHubFragment, GitHubInstallationOwner } from "@/fragno/github";
import {
  claimGitHubInstallation,
  describeGitHubInstallation,
  gitHubUserInstallationSchema,
  linkGitHubRepository,
  releaseGitHubInstallation,
  type GitHubCallRoute,
  type GitHubRouteFailure,
  type GitHubSignInOutcome,
} from "@/fragno/github-access";

export const GITHUB_INSTALLATION_MOVE_WORKFLOW_NAME = "github-installation-move";

/** The step after which the old workspace no longer reaches the installation's repositories. */
export const GITHUB_INSTALLATION_RELEASE_STEP = "forget the installation where it was";

const ownerSchema = backofficeRootOwnerSchema as unknown as z.ZodType<GitHubInstallationOwner>;

const gitHubInstallationMoveParamsSchema = z.strictObject({
  installation: gitHubUserInstallationSchema,
  from: ownerSchema,
  to: ownerSchema,
  repositories: z.array(z.string()),
});

export type GitHubInstallationMoveParams = z.output<typeof gitHubInstallationMoveParamsSchema>;

/**
 * How a move ended: it stops, changing nothing, when the installation was moved meanwhile, and
 * before syncing it here when another move took it on.
 */
export type GitHubInstallationMoveOutput =
  | { moved: true; outcome: Extract<GitHubSignInOutcome, { kind: "bound" }> }
  | { moved: false; message: string };

/** Where a move stands, as the sign-in's page shows it. */
export type GitHubInstallationMoveState =
  | { status: "moving" }
  | { status: "moved"; outcome: Extract<GitHubSignInOutcome, { kind: "bound" }> }
  | { status: "failed"; message: string };

/** What a move calls: the router, and each workspace's GitHub routes. */
export type GitHubInstallationMoveDependencies = {
  router: Pick<GitHubWebhookRouterCommands, "moveInstallationOwner" | "getInstallationOwner">;
  routesFor: (owner: GitHubInstallationOwner) => GitHubCallRoute;
};

/** Each workspace's GitHub routes, called as System. */
export function gitHubInstallationMoveDependencies(
  runtime: BackofficeRuntimeServices,
  kernel: BackofficeKernel,
): GitHubInstallationMoveDependencies {
  return {
    router: runtime.objects.githubWebhookRouter.singleton().commands,
    routesFor: (owner) => {
      const object = kernel.scoped("GITHUB", owner, runtime.objects.github);
      const transport = authorizedBackofficeObjectHttp(
        object.http,
        createBackofficeSystemExecution(owner),
      );
      return createRouteCaller<GitHubFragment>({
        baseUrl: "https://github.do",
        mountRoute: "/api/github",
        fetch: async (request) => {
          await object.commands.ensureAdminConfig();
          return await transport.fetch(request);
        },
      });
    },
  };
}

/**
 * One move per sign-in and installation, so moving again, as a page submitted twice does, finds the
 * move already started.
 */
export function gitHubInstallationMoveInstanceId(signInState: string, installationId: string) {
  const digest = createHash("sha256")
    .update(`github-installation-move:${signInState}:${installationId}`)
    .digest("hex");
  return `github-move-${digest.slice(0, 32)}`;
}

/** Moving retries for a while: until the old workspace forgets the installation, it reaches it. */
export const GITHUB_INSTALLATION_MOVE_RETRIES = {
  retries: { limit: 8, delay: "2 s", backoff: "exponential" },
} as const;

/** Another attempt may get past a transient failure; any other needs something to change first. */
function throwRouteFailure(failure: GitHubRouteFailure): never {
  throw failure.transient ? new Error(failure.message) : new NonRetryableError(failure.message);
}

/**
 * Moves a GitHub App installation from the workspace it serves to another. The user's sign-in showed
 * they reach the installation, and the page that starts the move checked that they manage GitHub in
 * both workspaces; the steps then run as System, so the move finishes even if that changes.
 *
 * Its webhooks go to the new workspace first, which also settles a race with another move. The old
 * workspace then forgets the installation, ending its connections to the repositories, since it
 * could reach them for as long as it keeps them. Last, the new workspace syncs the installation from
 * GitHub, which webhooks already reach it for, and links each repository the sign-in was for. Every
 * step can run again: the move and the release change nothing the second time, and syncing and
 * linking converge. A release or sync only writes while the router still agrees, so one that runs
 * late cannot undo a later move. It runs in System's Automations.
 */
export function defineGitHubInstallationMoveWorkflow(config: {
  ownerScope: BackofficeContextScope;
  dependencies: (() => GitHubInstallationMoveDependencies) | null;
}) {
  return defineWorkflow(
    {
      name: GITHUB_INSTALLATION_MOVE_WORKFLOW_NAME,
      schema: gitHubInstallationMoveParamsSchema,
      checkpoint: "step",
    },
    async (event, step): Promise<GitHubInstallationMoveOutput> => {
      if (config.ownerScope.kind !== "system" || !config.dependencies) {
        throw new NonRetryableError("GitHub installations move only in System's Automations.");
      }
      const { installation, from, to, repositories } = event.payload;
      const { router, routesFor } = config.dependencies();
      const source = routesFor(from);
      const destination = routesFor(to);

      const sent = await step.do("send the installation's webhooks here", async () => {
        const moved = await router.moveInstallationOwner(installation.id, from, to);
        if (moved.ok) {
          console.info("GitHub installation moved between workspaces", {
            installationId: installation.id,
            from: backofficeScopePathSegment(from),
            to: backofficeScopePathSegment(to),
          });
        }
        return moved;
      });
      if (!sent.ok) {
        return { moved: false, message: sent.message };
      }

      await step.do(
        GITHUB_INSTALLATION_RELEASE_STEP,
        GITHUB_INSTALLATION_MOVE_RETRIES,
        async () => {
          const failure = await releaseGitHubInstallation({
            router,
            callRoute: source,
            installation,
            owner: from,
          });
          if (failure !== null) {
            throwRouteFailure(failure);
          }
        },
      );

      const claimed = await step.do(
        "sync the installation here",
        GITHUB_INSTALLATION_MOVE_RETRIES,
        async () => {
          const result = await claimGitHubInstallation({
            router,
            callRoute: destination,
            installationId: installation.id,
            owner: to,
          });
          return result.kind === "failed" ? throwRouteFailure(result.failure) : result.kind;
        },
      );
      if (claimed === "moved") {
        return {
          moved: false,
          message: "The installation was moved again before it was synced here.",
        };
      }

      // One step per repository, each committed before the next starts, so a retry or replay
      // redoes only the link that failed.
      const links: { fullName: string; status: "linked" | "missing" }[] = [];
      for (const fullName of repositories) {
        const status = await step.do(
          `link ${fullName}`,
          GITHUB_INSTALLATION_MOVE_RETRIES,
          async () => {
            const result = await linkGitHubRepository(destination, fullName);
            return result.status === "failed" ? throwRouteFailure(result.failure) : result.status;
          },
        );
        links.push({ fullName, status });
      }

      return {
        moved: true,
        outcome: {
          kind: "bound",
          installation: describeGitHubInstallation(installation),
          synced: true,
          linked: links.filter(({ status }) => status === "linked").map(({ fullName }) => fullName),
          missing: links
            .filter(({ status }) => status === "missing")
            .map(({ fullName }) => fullName),
        },
      };
    },
  );
}
