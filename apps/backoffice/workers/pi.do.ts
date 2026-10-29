import { boundOutput } from "@earendil-works/chord/output";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { DurableObject } from "cloudflare:workers";
import type { PostHog } from "posthog-node";
import type { z } from "zod";

import type {
  PiAgent,
  PiAgentTurn,
  PiAgentPrompt,
  PiAgentSteer,
  PiAgentWork,
  PiAgentNotification,
  piAgentEntryPageRequestSchema,
  piAgentMessagePageRequestSchema,
  piAgentCompactionSchema,
  PiAgentCompactionStatus,
  PiAgentWaitingQueue,
  PiQueuedSubagent,
  PiSubagentRun,
  PiAgentSubmission,
} from "@/fragno/pi/agent/pi-agent-contract";
import type { PiAgentDependencies } from "@/fragno/pi/agent/pi-agent-harness";

import type { PiObject, PiAgentViewer, PiAgentViewing } from "./pi-object";

/** One durable agent per object; scoped managers own agent discovery. */
export class Pi extends DurableObject<CloudflareEnv> implements PiAgent {
  #object!: PiObject;
  // View sockets hibernate with the object, so they outlive this map, which `ctx` restores.
  readonly #disconnects = new Map<WebSocket, Promise<() => void>>();

  constructor(
    state: DurableObjectState,
    env: CloudflareEnv,
    loadDependencies: () => Promise<PiAgentDependencies> = async () => {
      const { createPiAgentDependencies } = await import("@/fragno/pi/agent/pi-agent-harness");
      return createPiAgentDependencies(env);
    },
  ) {
    super(state, env);
    // Imported on first use so that a cold isolate only evaluates the objects it wakes.
    void state.blockConcurrencyWhile(async () => {
      const { PiObject, openPiAgentStorage } = await import("./pi-object");
      const { createCloudflarePostHog, shutdownCloudflarePostHog } =
        await import("./lib/cloudflare-posthog");
      const { createPiPostHogExtension } =
        await import("@/fragno/pi/extensions/posthog/posthog-extension");
      const { createCloudflareDurableObjectRuntimeServices } =
        await import("@/backoffice-runtime/runtime-services");
      const { piAgentDurableObjectId } =
        await import("@/backoffice-runtime/cloudflare-durable-object-factory");
      const dependencies = await loadDependencies();
      const analyticsEnabled =
        import.meta.env.BACKOFFICE_TARGET === "cloudflare" &&
        import.meta.env.PROD &&
        Boolean(env.POSTHOG_PROJECT_TOKEN);
      async function queuePiGenerationEvent(event: Parameters<PostHog["capture"]>[0]) {
        const client = await createCloudflarePostHog(env);
        if (!client) {
          return;
        }
        try {
          client.capture(event);
        } finally {
          state.waitUntil(shutdownCloudflarePostHog(client));
        }
      }
      const runtime = createCloudflareDurableObjectRuntimeServices(env, state);
      this.#object = new PiObject({
        state,
        dependencies: analyticsEnabled
          ? {
              ...dependencies,
              extensions: (config, agent) => [
                ...dependencies.extensions(config, agent),
                createPiPostHogExtension({
                  config,
                  agent,
                  auth: runtime.objects.auth.singleton().commands,
                  capture: queuePiGenerationEvent,
                }),
              ],
            }
          : dependencies,
        runtime,
        openStorage: () => openPiAgentStorage(state.storage),
        idFromConfig: (config) => piAgentDurableObjectId(env, config),
        nowEpochMs: Date.now,
      });
      // An object woken from hibernation still has the view sockets it accepted; each had its view.
      // Only sockets with their view stay accepted while the object can hibernate: one that has none
      // yet is still connecting, which keeps the object awake, or was closed instead.
      for (const socket of state.getWebSockets()) {
        this.#disconnects.set(
          socket,
          Promise.resolve(this.#object.restoreViewer(piAgentSocketViewer(socket))),
        );
      }
    });
  }

  async initialize(config: PiAgentConfig): Promise<void> {
    await this.#object.initialize(config);
  }

  async warm(): Promise<void> {
    await this.#object.warm();
  }
  async steer(config: PiAgentConfig, revision: number, turn: PiAgentTurn, steer: PiAgentSteer) {
    await this.#object.steer(config, revision, turn, steer);
  }
  async dispatch(config: PiAgentConfig, revision: number, turn: PiAgentTurn, work: PiAgentWork) {
    await this.#object.dispatch(config, revision, turn, work);
  }
  async writeNotifications(config: PiAgentConfig, notifications: PiAgentNotification[]) {
    await this.#object.writeNotifications(config, notifications);
  }
  async startSubagent(
    config: PiAgentConfig,
    revision: number,
    turn: PiAgentTurn,
    prompt: PiAgentPrompt,
  ) {
    await this.#object.startSubagent(config, revision, turn, prompt);
  }
  async recordSubagent(config: PiAgentConfig, requestId: string, subagent: PiQueuedSubagent) {
    await this.#object.recordSubagent(config, requestId, subagent);
  }
  async getSubmission(config: PiAgentConfig, requestId: string): Promise<PiAgentSubmission | null> {
    return await this.#object.getSubmission(config, requestId);
  }
  async getSubagentRuns(config: PiAgentConfig, requestIds: string[]): Promise<PiSubagentRun[]> {
    return await this.#object.getSubagentRuns(config, requestIds);
  }
  async listEntries(config: PiAgentConfig, request: z.infer<typeof piAgentEntryPageRequestSchema>) {
    return await this.#object.listEntries(config, request);
  }
  async listMessages(
    config: PiAgentConfig,
    request: z.infer<typeof piAgentMessagePageRequestSchema>,
  ) {
    return await this.#object.listMessages(config, request);
  }
  async exportEntries(
    config: PiAgentConfig,
    history: boolean,
  ): Promise<ReadableStream<Uint8Array>> {
    return await this.#object.exportEntries(config, history);
  }
  async compact(
    config: PiAgentConfig,
    turn: PiAgentTurn,
    request: z.infer<typeof piAgentCompactionSchema>,
  ): Promise<{ taskId: number }> {
    return await this.#object.compact(config, turn, request);
  }
  async getCompaction(
    config: PiAgentConfig,
    taskId: number,
  ): Promise<PiAgentCompactionStatus | null> {
    return await this.#object.getCompaction(config, taskId);
  }
  async getView(config: PiAgentConfig, subagent: string | null): Promise<unknown> {
    return await this.#object.getView(config, subagent);
  }
  async publishQueue(queue: PiAgentWaitingQueue): Promise<void> {
    await this.#object.publishQueue(queue);
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("A Pi agent serves only its view socket.", { status: 426 });
    }
    const [{ piAgentConfigSchema }, { verifyAuthorizedBackofficeObjectRequest }] =
      await Promise.all([
        import("@fragno-dev/backoffice-api/v0/pi"),
        import("@/backoffice-runtime/internal-object-request"),
      ]);
    let viewing: PiAgentViewing;
    try {
      // The request names the agent, so its signature can be checked before the agent is read.
      const agent = piAgentConfigSchema.parse(
        JSON.parse(new URL(request.url).searchParams.get("agent") ?? "null"),
      );
      const verified = await verifyAuthorizedBackofficeObjectRequest({
        request,
        address: { binding: "PI", agent },
        env: this.env,
      });
      viewing = { agent, execution: verified.context.execution };
    } catch (cause) {
      return Response.json(
        {
          code: "INVALID_INTERNAL_CONTEXT",
          message: cause instanceof Error ? cause.message : "Invalid view socket request.",
        },
        { status: 401 },
      );
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable: an idle agent's open sockets do not keep the object in memory.
    this.ctx.acceptWebSocket(server);
    this.#disconnects.set(server, this.#object.connectViewer(piAgentSocketViewer(server), viewing));
    return new Response(null, { status: 101, webSocket: client });
  }
  // Viewers send nothing; the socket carries only the agent's frames.
  async webSocketMessage(): Promise<void> {}
  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.#disconnect(socket);
    try {
      socket.close(code, reason);
    } catch {
      // A code such as 1005 cannot be sent back, and a socket may already have closed.
    }
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    this.#disconnect(socket);
  }
  #disconnect(socket: WebSocket) {
    const disconnecting = this.#disconnects.get(socket);
    this.#disconnects.delete(socket);
    void disconnecting?.then((disconnect) => {
      disconnect();
    });
  }
  async reset(config: PiAgentConfig): Promise<void> {
    await this.#object.reset(config);
  }
  async abort(config: PiAgentConfig, revision: number): Promise<void> {
    await this.#object.abort(config, revision);
  }
  async alarm(): Promise<void> {
    await this.#object.alarm();
  }
}

function piAgentSocketViewer(socket: WebSocket): PiAgentViewer {
  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    },
    close(code, reason) {
      socket.close(code, closeReason(reason));
    },
  };
}

// close() throws on a reason over 123 UTF-8 bytes, which would turn a refusal into an unavailable
// close that viewers reconnect after. Denials name actors and grants, so they can be longer.
function closeReason(reason: string) {
  const bounded = boundOutput(reason, { maxBytes: 120, maxLines: 1, retain: "head" });
  return bounded.droppedBytes === 0 ? reason : `${bounded.text.trimEnd()}…`;
}
