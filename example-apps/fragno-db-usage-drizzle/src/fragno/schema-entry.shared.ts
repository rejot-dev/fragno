import type { DatabaseAdapter } from "@fragno-dev/db";
import { createAuthFragment } from "@fragno-dev/auth";
import { createCommentFragment } from "@fragno-dev/fragno-db-library";
import { createRatingFragment } from "@fragno-dev/fragno-db-library/upvote";
import { createWorkflowsFragment } from "@fragno-dev/workflows";
import { defaultFragnoRuntime } from "@fragno-dev/core";

// Shared fragment setup for schema generation entrypoints.
export function createSchemaFragments<TUOWConfig>(adapter: DatabaseAdapter<TUOWConfig>) {
  const authFragment = createAuthFragment(
    {},
    { databaseAdapter: adapter, databaseNamespace: "auth" },
  );
  const commentFragment = createCommentFragment(
    {},
    {
      databaseAdapter: adapter,
      outbox: { enabled: true },
    },
  );
  const ratingFragment = createRatingFragment(
    {},
    {
      databaseAdapter: adapter,
      outbox: { enabled: true },
    },
  );
  const workflowsFragment = createWorkflowsFragment(
    { runtime: defaultFragnoRuntime, workflows: {}, enableRunnerTick: false },
    { databaseAdapter: adapter },
  );

  return { authFragment, commentFragment, ratingFragment, workflowsFragment };
}
