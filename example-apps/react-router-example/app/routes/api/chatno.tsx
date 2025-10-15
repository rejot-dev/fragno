import { createChatno } from "../../chatno/chatno.server";

const handlers = createChatno().handlersFor("react-router");

export const action = handlers.action;
export const loader = handlers.loader;
