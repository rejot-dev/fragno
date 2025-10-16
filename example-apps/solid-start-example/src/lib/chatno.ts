import { createChatno } from "@fragno-dev/chatno";

export function createChatnoFragment() {
  return createChatno({ openaiApiKey: process.env.OPENAI_API_KEY! });
}
