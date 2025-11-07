import { fragment } from "~/lib/comment-fragment.server";

const handlers = fragment.handlersFor("react-router");

export const action = handlers.action;
export const loader = handlers.loader;
