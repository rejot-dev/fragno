import { cleanStores, getFinalStoreValues } from "../util/ssr";

/**
 * Advice from https://pragmaticwebsecurity.com/articles/spasecurity/json-stringify-xss.html
 * @param obj
 * @returns
 */
function javascriptEscaped(obj: unknown) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

/**
 * This method should be called after a first render pass is finished.
 * It gets all values from the stores and embeds them in a script tag in the HTML body.
 *
 * On the client side, this script tag is used to hydrate the stores.
 * Be sure to also call finishServerLoad when the page is rendered, to reset the stores for the next request.
 *
 * @returns A string to be embedded in a script tag in the HTML body
 */
export async function startServerLoad(): Promise<string> {
  const initialStoreValues = await getFinalStoreValues();

  console.log("initialStoreValues", initialStoreValues);

  return `window.__FRAGNO_INITIAL_DATA__ = ${javascriptEscaped(
    Array.from(initialStoreValues.entries()),
  )}`;
}

export async function initServerLoad() {
  cleanStores();
}

/**
 * Reset the stores for the next request.
 */
export async function finishServerLoad() {
  cleanStores();
}
