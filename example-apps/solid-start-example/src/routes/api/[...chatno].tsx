import { createChatnoFragment } from "~/lib/chatno";

export const { GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS } =
  createChatnoFragment().handlersFor("solid-start");
