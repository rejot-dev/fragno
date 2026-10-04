import { DurableObject } from "cloudflare:workers";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import { piAgentObjectName, type PiAgent } from "@/fragno/pi-manager/pi-agent-contract";

import { Auth, InMemoryAuthObject } from "./auth.do";
import { Automations } from "./automations.do";
import { createCloudflareBackofficeObjectContext } from "./lib/cloudflare-backoffice-object-implementation";
import { Mcp } from "./mcp.do";
import { PiScenarioAgent } from "./pi-durable-scenario.test-support";
import { InMemoryPiManagerObject } from "./pi-manager.do";
import { Upload } from "./upload.do";

export { PiScenarioAgent, Auth, Automations, Mcp, Upload };

/** Cloudflare test manager exposes the faux catalog used by PiScenarioAgent. */
export class PiScenarioManager extends DurableObject<CloudflareEnv> {
  readonly #object: InMemoryPiManagerObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new InMemoryPiManagerObject({
      ...createCloudflareBackofficeObjectContext(state, env),
      agent: (config): PiAgent =>
        env.PI.get(env.PI.idFromName(piAgentObjectName(config))) as unknown as PiAgent,
      supportedAvailableModels: async () => [
        { provider: "faux", modelId: "faux-1", label: "Faux 1" },
      ],
      nowEpochMs: Date.now,
    });
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}

export default {
  fetch() {
    return new Response("Backoffice Vitest worker");
  },
};

export class OutboxHarnessDurableObject extends DurableObject {
  async alarm() {}
}

export class WorkflowsHarnessDurableObject extends DurableObject {
  async alarm() {}
}

export class AuthSqlHarnessDurableObject extends DurableObject<CloudflareEnv> {
  readonly #auth: InMemoryAuthObject;
  readonly #runtime: BackofficeRuntimeServices;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const runtime = {
      config: {
        authEmailVerification: { enabled: false },
        signUpInvitationsEnabled: true,
      },
      objects: {
        auth: {
          singleton: () => ({
            commands: this.#auth,
            http: { fetch: async (request: Request) => await this.#auth.fetch(request) },
          }),
        },
        automations: {
          singleton: () => ({
            commands: { ingestEvent: async () => ({ accepted: true }) },
          }),
        },
        otp: {
          singleton: () => ({
            commands: {
              confirmSignUpInvitation: async (input: {
                invitationId: string;
                code: string;
                email: string;
              }) =>
                input.invitationId === "auth-sql-harness" && input.code === "AUTHSQL1"
                  ? { ok: true as const, invitationId: input.invitationId, email: input.email }
                  : { ok: false as const, reason: "invalid" as const },
            },
          }),
        },
      },
    } as unknown as BackofficeRuntimeServices;
    this.#runtime = runtime;
    this.#auth = new InMemoryAuthObject({ state, env, runtime });
  }

  fetch(request: Request) {
    return this.#auth.fetch(request);
  }

  async getBackofficeMe(input: {
    userId: string;
    activeOrganizationId: string | null;
  }): Promise<BackofficeMeData | null> {
    return await this.#auth.getBackofficeMe(input);
  }

  async getAllOrganizations(): Promise<Array<{ id: string }>> {
    return (await this.#auth.getAllOrganizations()).map(({ id }) => ({ id }));
  }

  async reinitializeAuth(): Promise<Array<{ id: string }>> {
    const auth = new InMemoryAuthObject({
      state: this.ctx,
      env: this.env,
      runtime: this.#runtime,
    });
    return (await auth.getAllOrganizations()).map(({ id }) => ({ id }));
  }

  alarm() {
    return this.#auth.alarm();
  }
}
