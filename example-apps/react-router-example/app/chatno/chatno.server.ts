import { createChatno as createChatnoFragment } from "@fragno-dev/chatno";

export function createChatno(): ReturnType<typeof createChatnoFragment> {
  return createChatnoFragment({ openaiApiKey: process.env.OPENAI_API_KEY! });
}
