import { PAGE_DEFINITION_VERSION, PAGE_LIMITS } from "./definition";

/**
 * Guest-side `page` builder. `sql` records a query's SQL as text with its interpolated values as
 * parameters, which are never written into the text, and `.columns` makes it a live query.
 * `page.define` renders the interface with `ui.render`, where each query or value a prop,
 * condition, or repeat reads becomes the state path the page fills. Every rule of the recorded
 * queries is the host's: `parsePageDefinition` validates the definition, and the host checks the
 * SQL against the scope's relations, in the build that produced it.
 */
const PAGE_BUILDER_SOURCE = String.raw`({ version, listItems, legacy }) => (ui, live) => {
  const fragments = new WeakMap();
  const queries = new WeakMap();
  const times = new WeakMap();
  const windows = new WeakMap();
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  // page.define names the queries and values its interface reads while it renders.
  let binding = null;
  const bound = (kind) => {
    if (binding === null) fail("A page's " + kind + " reach the interface through page.define.");
    return binding;
  };

  // A query's SQL is a list of text and parameters, joined with numbered placeholders by define.
  const literal = (value, label) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return { param: value };
    if (typeof value === "number") {
      // JSON writes NaN and the infinities as null, so the host would read a different value.
      if (!Number.isFinite(value)) fail(label + " must be a finite number.");
      return { param: value };
    }
    if (value instanceof Date) {
      fail(label + " is a Date; pages compare times against now, such as ${"$"}{now.minus(\"24 hours\")}.");
    }
    if (windows.has(value)) fail(label + " is intervals(...); pass it to bucket(time, intervals).");
    return fail(label + " expects a string, number, boolean, null, a list of them, a time such as now.minus(\"1 hour\"), or sql\`...\`; received " + describe(value) + ".");
  };
  const tokensOf = (value, label) => {
    if (fragments.has(value)) return fragments.get(value);
    if (queries.has(value)) return queries.get(value).tokens;
    if (times.has(value)) return [{ param: { now: times.get(value) } }];
    if (Array.isArray(value)) {
      if (value.length > listItems) fail(label + " lists at most " + listItems + " values.");
      return value.flatMap((item, index) => [...(index === 0 ? [] : [{ text: ", " }]), literal(item, label + " item " + index)]);
    }
    return [literal(value, label)];
  };
  const fragment = (tokens) => {
    const handle = Object.freeze({ columns: (columns) => makeQuery(tokens, columns) });
    fragments.set(handle, tokens);
    return handle;
  };
  const sql = (strings, ...values) => {
    if (!Array.isArray(strings) || !Array.isArray(strings.raw)) fail("sql is a tagged template, such as sql\`SELECT count(*) AS total FROM runs\`.");
    const tokens = [];
    strings.forEach((text, index) => {
      tokens.push({ text });
      if (index < values.length) tokens.push(...tokensOf(values[index], "sql\`...\` value " + index));
    });
    return fragment(tokens);
  };

  const valueOf = (handle) => (field, whenEmpty) => {
    const value = Object.freeze({});
    live.set(value, () => ({ $state: "/values/" + bound("values").value(value, { query: handle, field, whenEmpty }) }));
    return value;
  };
  const makeQuery = (tokens, columns) => {
    if (!isRecord(columns)) {
      fail(".columns({ ... }) declares the columns the query's rows show, such as { workflow: \"string\", startedAt: \"time\" }.");
    }
    const handle = Object.freeze({ value: (field, whenEmpty) => valueOf(handle)(field, whenEmpty) });
    queries.set(handle, { tokens, columns });
    live.set(handle, () => ({ $state: "/data/" + bound("queries").query(handle) }));
    return handle;
  };
  const compile = ({ tokens, columns }) => {
    const params = [];
    let text = "";
    for (const token of tokens) {
      if ("text" in token) {
        text += token.text;
      } else {
        params.push(token.param);
        text += "?" + params.length;
      }
    }
    return { sql: text.trim(), params, columns };
  };

  const units = new Map([
    ["ms", 1], ["millisecond", 1], ["s", 1000], ["sec", 1000], ["second", 1000],
    ["m", 60000], ["min", 60000], ["minute", 60000], ["h", 3600000], ["hr", 3600000], ["hour", 3600000],
    ["d", 86400000], ["day", 86400000], ["w", 604800000], ["week", 604800000],
  ]);
  const duration = (value, label) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(value) : null;
    const word = match ? match[2].toLowerCase() : "";
    const unit = units.get(word) ?? units.get(word.replace(/s$/, ""));
    if (!match || !unit) fail(label + " expects milliseconds or a duration such as \"30 minutes\", \"24 hours\", or \"7 days\".");
    return Number(match[1]) * unit;
  };
  const time = (offset) => {
    const handle = Object.freeze({
      minus: (amount) => time(offset - duration(amount, "now.minus")),
      plus: (amount) => time(offset + duration(amount, "now.plus")),
    });
    times.set(handle, offset);
    return handle;
  };
  const intervals = (options) => {
    if (!isRecord(options)) fail("intervals({ every, since }) expects options such as { every: \"1 hour\", since: now.minus(\"24 hours\") }.");
    if (!times.has(options.since)) fail("intervals since is a time relative to now, such as now.minus(\"24 hours\").");
    const window = { every: duration(options.every, "intervals every"), since: times.get(options.since) };
    const handle = Object.freeze({});
    windows.set(handle, window);
    // A chart's axis shows every interval, including those no row falls in.
    live.set(handle, () => window);
    return handle;
  };
  // The start of the interval a time falls in, aligned to whole intervals as chart axes are; null
  // before the first, and the newest interval for times after now.
  const bucket = (value, window) => {
    if (!windows.has(window)) fail("bucket(time, intervals) groups by intervals({ every, since }), such as bucket(\"run.createdAt\", intervals({ every: \"1 hour\", since: now.minus(\"24 hours\") })).");
    const tokens = typeof value === "string" ? [{ text: value }] : fragments.has(value) ? fragments.get(value) : fail("bucket(time, intervals) takes the time as SQL, such as \"run.createdAt\".");
    const { every, since } = windows.get(window);
    const timed = [{ text: "(" }, ...tokens, { text: ")" }];
    const start = (operand) => [...operand, { text: " / " + every + " * " + every }];
    return fragment([
      { text: "(CASE WHEN " }, ...timed, { text: " >= " }, { param: { now: since } },
      { text: " THEN min(" }, ...start(timed), { text: ", " }, ...start([{ param: { now: 0 } }]), { text: ") END)" },
    ]);
  };

  const context = { sql, now: time(0), intervals, bucket };
  // Sources written for the builder of version 4 destructure its functions, which fail clearly.
  for (const name of legacy) {
    Object.defineProperty(context, name, {
      enumerable: false,
      get: () =>
        fail("This page is written for an older page format: its build function reads " + name + ", which pages no longer get. Pages now query with sql\`...\`: rewrite its queries in SQL, as /static/skills/building-pages/SKILL.md describes."),
    });
  }
  Object.freeze(context);

  const define = (options, build) => {
    if (!isRecord(options) || typeof options.title !== "string") {
      fail("page.define(options, build) expects options such as { title: \"Home\" } first.");
    }
    if (typeof build !== "function") fail("page.define(options, build) expects build, a function that returns the page's root ui element.");
    const root = build(context);
    const queryNames = new Map();
    const valueNames = new Map();
    const fileQueries = {};
    const fileValues = {};
    const nameQuery = (query) => {
      if (!queryNames.has(query)) {
        const name = "q" + queryNames.size;
        queryNames.set(query, name);
        fileQueries[name] = compile(queries.get(query));
      }
      return queryNames.get(query);
    };
    let rendered;
    binding = {
      query: nameQuery,
      value: (value, { query, field, whenEmpty }) => {
        if (!valueNames.has(value)) {
          const name = "v" + valueNames.size;
          valueNames.set(value, name);
          fileValues[name] = { query: nameQuery(query), field, whenEmpty };
        }
        return valueNames.get(value);
      },
    };
    try {
      rendered = ui.render(root);
    } finally {
      binding = null;
    }
    if (Object.keys(rendered.state).length > 0) fail("Pages show data; they do not collect ui.form input.");
    return { version, title: options.title, queries: fileQueries, values: fileValues, spec: rendered.spec };
  };

  return Object.freeze({ define });
}`;

/** What the builder of version 4 gave a page's build function, which version 5 does not. */
const LEGACY_CONTEXT = [
  "collections",
  "from",
  "toArray",
  "unionAll",
  "eq",
  "gt",
  "gte",
  "lt",
  "lte",
  "and",
  "or",
  "not",
  "isNull",
  "inArray",
  "like",
  "ilike",
  "coalesce",
  "caseWhen",
  "concat",
  "upper",
  "lower",
  "length",
  "add",
  "subtract",
  "multiply",
  "divide",
  "count",
  "sum",
  "avg",
  "min",
  "max",
];

const builderConfig = JSON.stringify({
  version: PAGE_DEFINITION_VERSION,
  listItems: PAGE_LIMITS.listItems,
  legacy: LEGACY_CONTEXT,
});

/** An expression that, given the guest's `ui` builder and its live values, evaluates to `page`. */
export const pageBuilderSource = `(${PAGE_BUILDER_SOURCE})(${builderConfig})`;
