import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { PostHog } from "posthog-node";

import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

import type { BackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";
import { piAgentObjectName } from "@/fragno/pi/agent/pi-agent-contract";

async function generationEventUuid(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Provider-neutral usage capture; conversation content never enters the analytics transport. */
export function createPiPostHogExtension(input: {
  config: PiAgentConfig;
  agent: BackofficeAgentContext;
  capture(event: Parameters<PostHog["capture"]>[0]): Promise<void>;
}) {
  const { config, agent } = input;
  const agentId = piAgentObjectName(config);
  return defineExtension({
    name: "posthog",
    hooks: [
      hook(GenerationTask, {
        async afterResponse(message, api) {
          try {
            // A recovered terminal response must retain its ingestion identity without extra durable writes.
            const uuid = await generationEventUuid(
              `${agentId}:${api.conversationId}:${api.taskId}:${message.timestamp}`,
            );
            // Generations are attributed to the person whose turn they serve.
            const principal = (await agent.activeTurn(BACKGROUND_CONTEXT)).execution.actors
              .principal;
            const userId =
              principal?.scope === "internal" && principal.type === "user"
                ? principal.id
                : `pi-agent:${agentId}`;

            await input.capture({
              event: "$ai_generation",
              distinctId: userId,
              uuid,
              timestamp: new Date(message.timestamp),
              properties: {
                source: "cloudflare-pi",
                agent_name: config.agentName,
                conversation_id: api.conversationId,
                task_id: api.taskId,
                scope_kind: config.scope.kind,
                organization_id: backofficeScopeOrganization(config.scope)?.orgId ?? null,
                stop_reason: message.stopReason,
                $ai_trace_id: `${agentId}:${api.conversationId}:${api.taskId}`,
                $ai_session_id: agentId,
                $ai_span_id: uuid,
                $ai_provider: message.provider,
                $ai_model: message.responseModel ?? message.model,
                $ai_input_tokens: message.usage.input,
                $ai_output_tokens: message.usage.output,
                $ai_cache_read_input_tokens: message.usage.cacheRead,
                $ai_cache_creation_input_tokens: message.usage.cacheWrite,
                $ai_total_cost_usd: message.usage.cost.total,
                $ai_cost_passthrough: true,
                $ai_is_error: message.stopReason === "error" || message.stopReason === "aborted",
                $process_person_profile: false,
              },
            });
          } catch {
            console.warn("PostHog Pi generation capture failed.");
          }
        },
      }),
    ],
  });
}
