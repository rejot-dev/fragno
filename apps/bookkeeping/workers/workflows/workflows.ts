import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import {
  createFragmentDurableObjectHost,
  type FragmentDurableObjectHost,
} from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";
import { DurableObject } from "cloudflare:workers";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { SessionUser } from "../auth/auth";
import { createProvisioningClient } from "../backoffice/client";
import {
  CREATE_WORKSPACE_WORKFLOW,
  defineCreateWorkspaceWorkflow,
  type CreateWorkspaceParams,
  type WizardAnswer,
} from "./create-workspace";

/** Where a person is in the sign-up wizard. */
export type WizardState =
  | { step: "name" }
  | { step: "business-name" }
  | { step: "setting-up" }
  | { step: "done"; slug: string }
  | { step: "failed"; message: string };

function createWorkflows(ctx: DurableObjectState, env: CloudflareEnv) {
  return createWorkflowsFragment(
    {
      workflows: {
        createWorkspace: defineCreateWorkspaceWorkflow({
          setUserName: async (input) => {
            await env.AUTH.getByName("auth").setUserName(input);
          },
          provisioning: async () => await createProvisioningClient(env),
          recordMembership: async (input) => {
            await env.WORKSPACES.getByName("workspaces").recordMembership(input);
          },
        }),
      },
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter: new SqlAdapter({
        dialect: new DurableObjectDialect({ ctx, queryInstrumentation: null }),
        driverConfig: new CloudflareDurableObjectsDriverConfig(),
      }),
    },
  );
}

type WorkflowsFragment = ReturnType<typeof createWorkflows>;

/** Each person has one sign-up wizard. */
function wizardInstanceId(userId: string): string {
  return `wizard-${userId}`;
}

/** Bookkeeping's workflows in their own SQLite Durable Object; alarms run their steps. */
export class Workflows extends DurableObject<CloudflareEnv> {
  readonly #host: FragmentDurableObjectHost<void, WorkflowsFragment>;
  #fragment: WorkflowsFragment | null = null;

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.#host = createFragmentDurableObjectHost({
      name: "Workflows",
      state: ctx,
      env,
      createRuntime: () => createWorkflows(ctx, env),
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }

  /**
   * Starts the wizard for someone without a workspace, and reports its state. A wizard that
   * finished or was ended starts over: the workspace it made is gone for them.
   */
  async openWizard(user: SessionUser): Promise<WizardState> {
    const fragment = this.#getFragment();
    const params: CreateWorkspaceParams = {
      userId: user.id,
      backofficeUserId: user.backofficeUserId,
      email: user.email,
      name: user.name,
    };
    await fragment.callServices(() =>
      fragment.services.restartOrCreateInstance(CREATE_WORKSPACE_WORKFLOW, {
        id: wizardInstanceId(user.id),
        create: { params },
        restart: { precondition: { status: { in: ["complete", "terminated"] } } },
      }),
    );
    return await this.getWizard(user.id);
  }

  /** Tries the step that failed setting up the workspace again, keeping the answers given. */
  async retryWizard(userId: string): Promise<void> {
    const fragment = this.#getFragment();
    await fragment.callServices(() =>
      fragment.services.retryFailedStep(CREATE_WORKSPACE_WORKFLOW, wizardInstanceId(userId)),
    );
  }

  async getWizard(userId: string): Promise<WizardState> {
    const fragment = this.#getFragment();
    const instanceId = wizardInstanceId(userId);
    const status = await fragment.callServices(() =>
      fragment.services.getInstanceStatus(CREATE_WORKSPACE_WORKFLOW, instanceId),
    );
    switch (status.status) {
      case "complete":
        // The workflow's own return value.
        return { step: "done", slug: (status.output as { slug: string }).slug };
      case "errored":
      case "terminated":
        return { step: "failed", message: status.error?.message ?? "Setting up failed." };
      case "waiting": {
        const current = await fragment.callServices(() =>
          fragment.services.getInstanceCurrentStep(CREATE_WORKSPACE_WORKFLOW, instanceId),
        );
        const question = current?.waitEventType;
        if (question !== "name" && question !== "business-name") {
          return { step: "setting-up" };
        }
        // An answer is stored when it is sent, but the workflow takes it on its next run; the page
        // reloads before that, and must not ask the question again.
        const { events } = await fragment.callServices(() =>
          fragment.services.listHistory({ workflowName: CREATE_WORKSPACE_WORKFLOW, instanceId }),
        );
        const answered = events.some(
          (event) => event.type === question && event.consumedByStepKey === null,
        );
        return answered ? { step: "setting-up" } : { step: question };
      }
      case "active":
      case "paused":
        return { step: "setting-up" };
      default:
        throw new Error(`Unknown workflow status ${String(status.status satisfies never)}.`);
    }
  }

  async answerWizard(input: { userId: string; answer: WizardAnswer }): Promise<void> {
    const fragment = this.#getFragment();
    await fragment.callServices(() =>
      fragment.services.sendEvent(CREATE_WORKSPACE_WORKFLOW, wizardInstanceId(input.userId), {
        type: input.answer.type,
        payload: input.answer.payload,
        // An answer sent twice, e.g. from two tabs, can arrive after the workspace exists; the
        // page then shows the wizard as it is.
        ignoreTerminal: true,
      }),
    );
  }

  #getFragment(): WorkflowsFragment {
    if (!this.#fragment) {
      throw new Error("Bookkeeping's workflows are unavailable.");
    }
    return this.#fragment;
  }
}
