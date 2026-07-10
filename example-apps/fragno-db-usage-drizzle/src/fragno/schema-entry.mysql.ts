import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { MySQL2DriverConfig } from "@fragno-dev/db/drivers";

import { createNoopDialect } from "./schema-entry.dialect";
import {
  createSchemaFragments,
  type AuthFragment,
  type CommentFragment,
  type RatingFragment,
  type WorkflowsFragment,
} from "./schema-entry.shared";

const adapter = new SqlAdapter({
  dialect: createNoopDialect({ supportsReturning: false }),
  driverConfig: new MySQL2DriverConfig(),
});

const fragments = createSchemaFragments(adapter);

export const authFragment: AuthFragment = fragments.authFragment;
export const commentFragment: CommentFragment = fragments.commentFragment;
export const ratingFragment: RatingFragment = fragments.ratingFragment;
export const workflowsFragment: WorkflowsFragment = fragments.workflowsFragment;
