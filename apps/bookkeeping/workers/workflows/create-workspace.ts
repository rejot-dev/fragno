import {
  BackofficeApiRequestError,
  type BackofficeProvisioningClient,
} from "@fragno-dev/backoffice-api/v0/client";
import { defineWorkflow, NonRetryableError } from "@fragno-dev/workflows/workflow";

import type { Workspace, WorkspaceMember } from "../workspaces/workspaces";

export const CREATE_WORKSPACE_WORKFLOW = "create-workspace";

/** Who the wizard sets a workspace up for, as their session was when it started. */
export type CreateWorkspaceParams = {
  userId: string;
  backofficeUserId: string;
  email: string;
  /** Their name, or "" when Backoffice's sign-up did not ask for one; the wizard asks then. */
  name: string;
};

/** What a person answers in the wizard; each answer is an event the workflow waits for. */
export type WizardAnswer =
  | { type: "name"; payload: { name: string } }
  | { type: "business-name"; payload: { businessName: string } };

export type CreateWorkspaceDependencies = {
  setUserName(input: { userId: string; name: string }): Promise<void>;
  provisioning(): Promise<BackofficeProvisioningClient>;
  recordMembership(input: {
    workspace: Workspace;
    member: WorkspaceMember;
    confirmedAt: number;
  }): Promise<void>;
};

/**
 * The sign-up wizard: asks for what Bookkeeping needs, then creates the workspace. Answers wait
 * durably, so people can leave and come back. The Backoffice organization's identifier in
 * Bookkeeping is the instance ID, so creating it again finds the one already made.
 */
export function defineCreateWorkspaceWorkflow(dependencies: CreateWorkspaceDependencies) {
  return defineWorkflow<typeof CREATE_WORKSPACE_WORKFLOW, CreateWorkspaceParams, { slug: string }>(
    { name: CREATE_WORKSPACE_WORKFLOW },
    async (event, step) => {
      const { userId, backofficeUserId, email } = event.payload;
      const asksName = event.payload.name === "";
      const name = asksName
        ? (await step.waitForEvent<{ name: string }>("ask their name", { type: "name" })).payload
            .name
        : event.payload.name;
      if (asksName) {
        await step.do("save their name", async () => {
          await dependencies.setUserName({ userId, name });
        });
      }

      const {
        payload: { businessName },
      } = await step.waitForEvent<{ businessName: string }>("ask the business name", {
        type: "business-name",
      });

      const organization = await step.do(
        "create the organization in Backoffice",
        { retries: { limit: 5, delay: "2 s", backoff: "exponential" } },
        async () => {
          const provisioning = await dependencies.provisioning();
          try {
            return await provisioning.call("organizations.provision", {
              externalOrganizationId: event.instanceId,
              name: businessName,
              ownerUserId: backofficeUserId,
            });
          } catch (error) {
            // Backoffice refused the request itself; asking again cannot change its answer.
            if (error instanceof BackofficeApiRequestError && error.code !== null) {
              throw new NonRetryableError(error.message);
            }
            throw error;
          }
        },
      );

      await step.do("add the workspace", async () => {
        await dependencies.recordMembership({
          workspace: {
            id: organization.organizationId,
            slug: organization.slug,
            name: businessName,
          },
          member: { userId: backofficeUserId, name, email, roles: ["owner"] },
          confirmedAt: Date.now(),
        });
      });
      return { slug: organization.slug };
    },
  );
}
