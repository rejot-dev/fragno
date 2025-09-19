import OpenAI from "openai";
import { z } from "zod";
import type {
  EasyInputMessage,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses.mjs";
import { defineRoute, defineRoutes } from "@fragno-dev/core";

export const ChatMessageSchema = z.object({
  type: z.literal("chat"),
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const FunctionCallMessageSchema = z.object({
  type: z.literal("functionCall"),
  id: z.string(),
  functionCallId: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const FunctionCallOutputMessageSchema = z.object({
  type: z.literal("functionCallOutput"),
  id: z.string(),
  functionCallId: z.string(),
  output: z.string(),
  status: z.enum(["inProgress", "completed", "incomplete"]),
});

export const InputMessageSchema = z.discriminatedUnion("type", [
  ChatMessageSchema,
  FunctionCallMessageSchema,
  FunctionCallOutputMessageSchema,
]);

// Request schema with unified messages array
export const ChatStreamRequestSchema = z.object({
  messages: z.array(InputMessageSchema),
});

export const ResponseTextDeltaEventSchema = z.object({
  type: z.literal("response.output_text.delta"),
  content_index: z.number(),
  delta: z.string(),
  item_id: z.string(),
  output_index: z.number(),
  sequence_number: z.number(),
});

export const ResponseTextDoneEventSchema = z.object({
  type: z.literal("response.output_text.done"),
  content_index: z.number(),
  item_id: z.string(),
  output_index: z.number(),
  sequence_number: z.number(),
  text: z.string(),
});

export const ResponseEventSchema = z.discriminatedUnion("type", [
  ResponseTextDeltaEventSchema,
  ResponseTextDoneEventSchema,
]);

type ChatRouteConfig = {
  model: "gpt-5-mini" | "4o-mini";
  systemPrompt: string;
};

type ChatRouteDeps = {
  openaiClient: OpenAI;
};

export const chatRouteFactory = defineRoutes<ChatRouteConfig, ChatRouteDeps>().create(
  ({ config, deps }) => {
    const { openaiClient } = deps;
    const { model, systemPrompt } = config;

    return [
      defineRoute({
        method: "POST",
        path: "/chat/stream",
        inputSchema: ChatStreamRequestSchema,
        outputSchema: z.array(ResponseEventSchema),
        handler: async ({ input }, { jsonStream }) => {
          const { messages } = await input.valid();

          const openAIMessages: ResponseInputItem[] = messages.map((message) => {
            if (message.type === "chat") {
              return {
                role: message.role,
                content: message.content,
              } satisfies EasyInputMessage;
            }

            if (message.type === "functionCall") {
              return {
                type: "function_call",
                id: message.id,
                call_id: message.functionCallId,
                name: message.name,
                arguments: message.arguments,
              } satisfies ResponseFunctionToolCall;
            }

            if (message.type === "functionCallOutput") {
              return {
                type: "function_call_output",
                call_id: message.functionCallId,
                output: message.output,
                status:
                  message.status === "inProgress"
                    ? "in_progress"
                    : message.status === "completed"
                      ? "completed"
                      : "incomplete",
              } satisfies ResponseInputItem.FunctionCallOutput;
            }

            throw new Error("unreachable");
          });

          try {
            const eventStream = await openaiClient.responses.create({
              model,
              input: [
                {
                  role: "system",
                  content: systemPrompt,
                },
                ...openAIMessages,
              ],
              // tools: [],
              // tool_choice: "auto",
              stream: true,
            });

            return jsonStream(async (stream) => {
              for await (const event of eventStream) {
                if (
                  event.type !== "response.output_text.delta" &&
                  event.type !== "response.output_text.done"
                ) {
                  continue;
                }

                await stream.write(event);
              }
            });
          } catch (error) {
            console.error("OpenAI API error:", error);
            throw error;
          }
        },
      }),
    ];
  },
);
