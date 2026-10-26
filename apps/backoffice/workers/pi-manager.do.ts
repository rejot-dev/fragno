import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import { DurableObject } from "cloudflare:workers";

import type { PiManagerCommands } from "@/backoffice-runtime/object-registry";
import type { PiAgent } from "@/fragno/pi/agent/pi-agent-contract";
import type { PackageAgentsInput } from "@/fragno/pi/manager/package-agents";

import type { PiManagerObject } from "./pi-manager-object";

/** Singleton, organization, user, and project agent directories match Automations scopes. */
export class PiManager extends DurableObject<CloudflareEnv> implements PiManagerCommands {
  #object!: PiManagerObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { PiManagerObject } = await import("./pi-manager-object");
      const {
        createPiModels,
        listAvailablePiModels,
        createPiClassifier,
        createPiImageGenerator,
        createPiExtractor,
      } = await import("@/fragno/pi/agent/pi-models");
      const { createCloudflareBackofficeObjectContext } =
        await import("./lib/cloudflare-backoffice-object-implementation");
      const { piAgentObjectName } = await import("@/fragno/pi/agent/pi-agent-contract");
      const models = createPiModels(env);
      this.#object = new PiManagerObject({
        ...createCloudflareBackofficeObjectContext(state, env),
        agent: (config): PiAgent =>
          env.PI.get(env.PI.idFromName(piAgentObjectName(config))) as unknown as PiAgent,
        supportedAvailableModels: async () => await listAvailablePiModels(models),
        classifier: createPiClassifier(env, fetch),
        imageGenerator: createPiImageGenerator(env, fetch),
        extractor: createPiExtractor(env, fetch),
        nowEpochMs: Date.now,
      });
    });
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }

  async fetch(request: Request): Promise<Response> {
    return await this.#object.fetch(request);
  }

  async reportSettledTurn(input: { agentName: string; requestId: string }): Promise<void> {
    await this.#object.reportSettledTurn(input);
  }

  async authorizeViewer(
    input: Parameters<PiManagerCommands["authorizeViewer"]>[0],
  ): ReturnType<PiManagerCommands["authorizeViewer"]> {
    return await this.#object.authorizeViewer(input);
  }

  async classify(
    input: Parameters<PiManagerCommands["classify"]>[0],
  ): ReturnType<PiManagerCommands["classify"]> {
    return await this.#object.classify(input);
  }

  async generateImage(
    input: Parameters<PiManagerCommands["generateImage"]>[0],
  ): ReturnType<PiManagerCommands["generateImage"]> {
    return await this.#object.generateImage(input);
  }

  async extract(
    input: Parameters<PiManagerCommands["extract"]>[0],
  ): ReturnType<PiManagerCommands["extract"]> {
    return await this.#object.extract(input);
  }

  async checkPackageAgents(input: Omit<PackageAgentsInput, "actors">) {
    return await this.#object.checkPackageAgents(input);
  }

  async applyPackageAgents(input: PackageAgentsInput) {
    return await this.#object.applyPackageAgents(input);
  }

  async removePackageAgents(input: { listingId: string; actors: AutomationActors }) {
    return await this.#object.removePackageAgents(input);
  }

  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}
