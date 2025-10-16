import { airweaveFragment } from "~/lib/airweave-server";

const handlers = airweaveFragment.handlersFor("react-router");

export const loader = handlers.loader;
export const action = handlers.action;
