import { define } from "gunshi";
import { baseArgs, createClientFromContext } from "../../utils/options.js";
import { formatJson } from "../../utils/format.js";

const tryParseJson = (value: string): unknown | undefined => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const resolveMessageContent = (raw: string) => {
  const parsed = tryParseJson(raw);

  if (parsed === undefined) {
    return { content: { type: "text", text: raw }, text: raw };
  }

  if (typeof parsed === "string") {
    return { content: { type: "text", text: parsed }, text: parsed };
  }

  if (parsed && typeof parsed === "object") {
    const textValue = (parsed as { type?: unknown; text?: unknown }).text;
    if ((parsed as { type?: unknown }).type === "text" && typeof textValue === "string") {
      return { content: parsed, text: textValue };
    }
  }

  return { content: parsed, text: null };
};

export const messagesAppendCommand = define({
  name: "append",
  description: "Append a message to a thread",
  args: {
    ...baseArgs,
    thread: {
      type: "string",
      short: "t",
      description: "Thread ID",
    },
    role: {
      type: "string",
      description: "Message role (user|assistant|system)",
    },
    content: {
      type: "string",
      description: "Message content (text or JSON)",
    },
    run: {
      type: "string",
      description: "Associate with a run ID",
    },
    json: {
      type: "boolean",
      description: "Output JSON",
    },
  },
  run: async (ctx) => {
    const threadId = ctx.values["thread"] as string | undefined;
    if (!threadId) {
      throw new Error("Missing --thread");
    }

    const contentRaw = ctx.values["content"] as string | undefined;
    if (!contentRaw) {
      throw new Error("Missing --content");
    }

    const role = (ctx.values["role"] as string | undefined) ?? "user";
    const resolved = resolveMessageContent(contentRaw);

    const client = createClientFromContext(ctx);
    const message = await client.appendMessage({
      threadId,
      role,
      content: resolved.content,
      text: resolved.text,
      runId: (ctx.values["run"] as string | undefined) ?? null,
    });

    if (ctx.values["json"]) {
      console.log(formatJson(message));
      return;
    }

    console.log(`Appended message ${message["id"]} to thread ${threadId}`);
  },
});
