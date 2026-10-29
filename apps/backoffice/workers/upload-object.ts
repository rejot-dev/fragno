import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import { resolveBackofficeInternalRequestSecret } from "@/backoffice-runtime/internal-object-request";
import {
  assertBackofficeObjectAddressAllowed,
  decodeBackofficeObjectScope,
  type UploadCommands,
} from "@/backoffice-runtime/object-registry";
import {
  loadDurableHook,
  loadDurableHookQueue,
  type DurableHookQueueOptions,
} from "@/fragno/durable-hooks";
import { createUploadServer, type UploadFragment } from "@/fragno/upload-server";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

/** Stores one scope's files, the workspace, in the object's own database. */
export class UploadObject implements UploadCommands {
  readonly #host: FragmentDurableObjectHost<void, UploadFragment>;
  readonly #initialization: Promise<void>;
  #fragment: UploadFragment | null = null;

  constructor({
    state,
    env,
    implementation,
  }: {
    state: BackofficeObjectState & Pick<DurableObjectState, "id">;
    env: Pick<BackofficeRuntimeEnv, "BACKOFFICE_INTERNAL_REQUEST_SECRET">;
    implementation: BackofficeObjectImplementation;
  }) {
    const objectName = state.id.name;
    const scope = objectName ? decodeBackofficeObjectScope(objectName) : null;
    if (!objectName || !scope || scope.kind === "singleton") {
      throw new Error("Upload Durable Object requires a named, non-singleton identity.");
    }
    assertBackofficeObjectAddressAllowed({ binding: "UPLOAD", scope });

    this.#host = implementation.createFragmentHost({
      name: "Upload",
      createRuntime: () =>
        createUploadServer({
          runtime: implementation.fragmentDatabase,
          // The object name identifies the file namespace, so links only open files of the object
          // that signed them.
          fileLinkSigning: {
            secret: resolveBackofficeInternalRequestSecret(env),
            audience: objectName,
          },
        }),
      onProcessError: (error) => {
        console.error("Upload hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Upload hook dispatcher initialization failed", error);
      },
    });
    this.#initialization = state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(): UploadFragment {
    if (!this.#fragment) {
      throw new Error("Upload is unavailable.");
    }
    return this.#fragment;
  }

  async warm(): Promise<void> {
    await this.#initialization;
  }

  async getDurableHookQueue(options?: DurableHookQueueOptions) {
    await this.#initialization;
    return await loadDurableHookQueue(this.#getFragment(), options);
  }

  async getDurableHook(hookId: string) {
    await this.#initialization;
    return await loadDurableHook(this.#getFragment(), hookId);
  }

  async wakeDurableHooks() {
    await this.#host.wake();
  }

  async alarm(): Promise<void> {
    await this.#initialization;
    await this.#host.alarm();
  }

  async fetch(request: Request): Promise<Response> {
    await this.#initialization;
    return await this.#host.fetch(this.#getFragment(), request);
  }
}
