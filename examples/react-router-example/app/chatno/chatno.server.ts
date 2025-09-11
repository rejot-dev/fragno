import { createChatno as libraryCreateChatno } from "@fragno-dev/chatno";

export function createChatno() {
  return libraryCreateChatno({ openaiApiKey: process.env.OPENAI_API_KEY! });
}
