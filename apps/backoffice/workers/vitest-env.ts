import { DurableObject } from "cloudflare:workers";

import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import { InMemoryAuthObject } from "./auth.do";

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
