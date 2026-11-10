import { SITE_DATA_LIMITS } from "./site-data";

/**
 * Guest-side `env.DATA`, which a site's Worker gets in place of the binding it wraps. `sql` builds
 * a query as a page's `sql` does: interpolated values become parameters and are never written into
 * the text, a list becomes a subquery for IN (...), and `sql` fragments nest. Awaiting a query
 * reads it, and returns its rows as objects by column name, with values as SQL holds them. `fire`
 * fires an event, its payload as JSON reads it, and returns its id, or null for the request an agent
 * sent, which keeps it instead. The host checks every query and event again; these checks only fail
 * where the mistake is, in the site's code.
 * Each request gets its own, which remembers whether a read found the scope's copy catching up: the
 * site's entry then answers that the site is unavailable, whatever the Worker made of the error.
 */
const SITE_DATA_SOURCE = String.raw`({ listItems, params: maxParams }) => (binding) => {
  let catchingUp = false;
  const fragments = new WeakMap();
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  const literal = (value, label) => {
    if (value === null || typeof value === "string") return value;
    // SQLite has no booleans: it stores them, and pages read them, as 1 and 0.
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(label + " must be a finite number.");
      return value;
    }
    if (value instanceof Date) {
      const time = value.getTime();
      if (Number.isNaN(time)) fail(label + " is an invalid Date.");
      // Times are milliseconds since the epoch, as the relations hold them.
      return time;
    }
    return fail(label + " expects a string, number, boolean, null, Date, a list of them, or sql\`...\`; received " + describe(value) + ".");
  };
  const tokensOf = (value, label) => {
    if (fragments.has(value)) return fragments.get(value);
    if (Array.isArray(value)) {
      if (value.length > listItems) fail(label + " lists at most " + listItems + " values.");
      // One JSON parameter for the whole list, as the subquery IN (...) reads: a list costs one of
      // the parameters SQLite binds, however long it is.
      const items = value.map((item, index) => literal(item, label + " item " + index));
      return [{ text: "SELECT value FROM json_each(" }, { param: JSON.stringify(items) }, { text: ")" }];
    }
    return [{ param: literal(value, label) }];
  };
  const read = async (tokens) => {
    const params = [];
    let text = "";
    for (const token of tokens) {
      if ("text" in token) {
        text += token.text;
      } else {
        params.push(token.param);
        text += "?";
      }
    }
    if (params.length > maxParams) fail("A query binds at most " + maxParams + " values; a list binds one.");
    const result = await binding.query({ sql: text.trim(), params });
    if (result.status === "catching-up") {
      catchingUp = true;
      throw new Error("The site's data is being copied; it is unavailable until the copy catches up.");
    }
    if (result.status === "error") throw new Error(result.message);
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
  };
  const fire = async (event) => {
    if (typeof event !== "object" || event === null) fail("fire takes { type, payload, viewer }, such as fire({ type: 'order.placed', payload: { sku } }).");
    const { type, payload = {}, viewer = null } = event;
    if (typeof type !== "string" || type.trim() === "") fail("An event's type is text, such as 'order.placed'; received " + describe(type) + ".");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) fail("An event's payload is an object; received " + describe(payload) + ".");
    if (viewer !== null && typeof viewer !== "string") fail("An event's viewer is the viewer's id, such as request.headers.get('ley-viewer-id'), or null; received " + describe(viewer) + ".");
    let json;
    try {
      json = JSON.stringify(payload);
    } catch (error) {
      fail("An event's payload is JSON: " + error.message);
    }
    const result = await binding.fire({ type, payload: JSON.parse(json), viewer });
    if (result.status === "error") throw new Error(result.message);
    return { eventId: result.status === "fired" ? result.eventId : null };
  };
  const sql = (strings, ...values) => {
    if (!Array.isArray(strings) || !Array.isArray(strings.raw)) fail("sql is a tagged template, such as sql\`SELECT count(*) AS total FROM runs\`.");
    const tokens = [];
    strings.forEach((text, index) => {
      tokens.push({ text });
      if (index < values.length) tokens.push(...tokensOf(values[index], "sql\`...\` value " + index));
    });
    // Awaiting a query reads it; including it in another query only includes its SQL.
    const handle = Object.freeze({ then: (resolve, reject) => read(tokens).then(resolve, reject) });
    fragments.set(handle, tokens);
    return handle;
  };
  return { data: Object.freeze({ sql, fire }), catchingUp: () => catchingUp };
}`;

const config = JSON.stringify({
  listItems: SITE_DATA_LIMITS.listItems,
  params: SITE_DATA_LIMITS.params,
});

/**
 * An expression that, given the binding a site Worker reads through, evaluates to one request's
 * `env.DATA` as `data`, and `catchingUp`, which tells whether a read found the copy catching up.
 */
export const siteDataClientSource = `(${SITE_DATA_SOURCE})(${config})`;
