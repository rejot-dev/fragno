/** The app's permanent name in Backoffice, as `backoffice:connect` registers it. */
export const BOOKKEEPING_APP_SLUG = "bookkeeping";

/** How Backoffice's agents reach Bookkeeping's actions: the app's slug, as registered. */
export const BOOKKEEPING_CONNECTION_ID = `app#${BOOKKEEPING_APP_SLUG}`;

/**
 * The agent in each firm's agent project that proposes how to book its clients' documents and bank
 * transactions, which Bookkeeping's requests are routed to.
 */
export const BOOKKEEPER_AGENT_NAME = "bookkeeper";
