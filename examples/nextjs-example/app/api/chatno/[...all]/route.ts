import { createChatno } from "@rejot-dev/chatno";
import { toNextJsHandler } from "@rejot-dev/fragno";

const chatno = createChatno({
  mountRoute: "/api/chatno",
});

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(chatno);