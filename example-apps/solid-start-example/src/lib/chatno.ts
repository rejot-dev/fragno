import { createChatno } from "@fragno-dev/chatno";

function createChatnoFragment() {
  return createChatno({ openaiApiKey: process.env.OPENAI_API_KEY! });
}

export const chatnoFragment = createChatnoFragment();
