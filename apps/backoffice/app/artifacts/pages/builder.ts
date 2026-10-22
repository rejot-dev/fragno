import { PAGE_DEFINITION_VERSION, PAGE_QUERY_AGGREGATES, PAGE_QUERY_FUNCTIONS } from "./definition";

/**
 * Guest-side `page` builder. It records TanStack-style calls as the file's query JSON and checks
 * only what cannot be recorded, such as a Date where a value belongs. `page.define` renders the
 * interface with `ui.render`, where each query or value a prop, condition, or repeat reads becomes
 * the state path the page fills. Every rule of the recorded queries is the host's:
 * `parsePageDefinition` validates the definition in the build that produced it.
 */
const PAGE_BUILDER_SOURCE = String.raw`({ functions, aggregates, version }) => (ui, live) => {
  const expressions = new WeakMap();
  const sources = new WeakMap();
  const queries = new WeakMap();
  const manys = new WeakMap();
  const windows = new WeakMap();
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  const ignoredKey = (key) => typeof key !== "string" || key === "then" || key === "toJSON";
  // page.define names the queries and values its interface reads while it renders.
  let binding = null;
  const bound = (kind) => {
    if (binding === null) fail("A page's " + kind + " reach the interface through page.define.");
    return binding;
  };

  const expression = (ir, methods = {}) => {
    const handle = Object.freeze(methods);
    expressions.set(handle, ir);
    return handle;
  };
  const toExpression = (value, label) => {
    if (expressions.has(value)) return expressions.get(value);
    if (value === null || typeof value === "string" || typeof value === "boolean") return { value };
    if (typeof value === "number") {
      // JSON writes NaN and the infinities as null, so the host would read a different value.
      if (!Number.isFinite(value)) fail(label + " must be a finite number.");
      return { value };
    }
    if (value instanceof Date) {
      fail(label + " is a Date; pages compare times against now, such as now.minus(\"24 hours\").");
    }
    if (queries.has(value)) fail(label + " is a query; select nested rows with many(query), or pass it to props such as ui.table rows.");
    if (manys.has(value)) fail(label + " is many(query), which is a whole select field.");
    return fail(label + " expects a field, a page function, or a string, number, boolean, or null; received " + describe(value) + ".");
  };
  // A field reads nested values by property, such as route.trigger.kind; the host checks that the
  // field exists and is JSON.
  const fieldRef = (path) => {
    const ref = new Proxy(Object.freeze({}), {
      get: (_, key) => (ignoredKey(key) ? undefined : fieldRef([...path, key])),
    });
    expressions.set(ref, { ref: path });
    return ref;
  };
  const refsFor = (aliases) =>
    new Proxy(Object.freeze({}), {
      get: (_, key) => (ignoredKey(key) || !aliases.includes(key) ? undefined : fieldRef([key])),
    });
  const callback = (fn, label) => {
    if (typeof fn !== "function") fail(label + " expects a callback such as ({ run }) => run.status.");
    return fn;
  };

  const collections = new Proxy(Object.freeze({}), {
    get: (_, key) => {
      if (ignoredKey(key)) return undefined;
      const handle = Object.freeze({});
      sources.set(handle, key);
      return handle;
    },
  });
  const readSource = (source, label) => {
    const entries = isRecord(source) && !queries.has(source) ? Object.entries(source) : [];
    if (entries.length !== 1) {
      fail(label + " expects one aliased collection or query, such as { run: collections.workflowInstances }.");
    }
    const [[alias, handle]] = entries;
    if (queries.has(handle)) return { alias, query: queries.get(handle) };
    if (!sources.has(handle)) fail(label + " " + alias + " must be one of collections, such as collections.workflowInstances, or a query.");
    return { alias, collection: sources.get(handle) };
  };

  const valueOf = (handle) => (field, whenEmpty) => {
    const value = Object.freeze({});
    live.set(value, () => ({ $state: "/values/" + bound("values").value(value, { query: handle, field, whenEmpty }) }));
    return value;
  };
  const register = (handle, state) => {
    queries.set(handle, state);
    live.set(handle, () => ({ $state: "/data/" + bound("queries").query(handle) }));
    return handle;
  };

  const makeQuery = (state) => {
    const aliases = [state.from.alias, ...state.joins.map(({ source }) => source.alias)];
    const read = (fn, label) => callback(fn, label)(refsFor(aliases));
    const next = (changes) => makeQuery({ ...state, ...changes });
    const join = (type, method) => (source, on) => {
      const joined = readSource(source, method + "(source, on)");
      const condition = toExpression(callback(on, method)(refsFor([...aliases, joined.alias])), method + " on");
      if (!("fn" in condition) || condition.fn !== "eq") {
        fail(method + "(source, on) matches two fields: return eq(field, field), such as eq(run.id, step.instanceRef).");
      }
      return next({ joins: [...state.joins, { type, source: joined, on: condition.args }] });
    };
    const handle = Object.freeze({
      join: join("inner", "join"),
      leftJoin: join("left", "leftJoin"),
      where: (fn) => next({ where: [...state.where, toExpression(read(fn, "where"), "where")] }),
      groupBy: (fn) => {
        const result = read(fn, "groupBy");
        const keys = Array.isArray(result) ? result : [result];
        return next({ groupBy: [...state.groupBy, ...keys.map((key, index) => toExpression(key, "groupBy key " + index))] });
      },
      having: (fn) => next({ having: [...state.having, toExpression(read(fn, "having"), "having")] }),
      select: (fn) => {
        const result = read(fn, "select");
        if (!isRecord(result) || expressions.has(result) || queries.has(result)) {
          fail("select returns an object of fields, such as ({ run }) => ({ status: run.status }).");
        }
        return next({
          select: Object.fromEntries(
            Object.entries(result).map(([name, value]) => [name, manys.has(value) ? manys.get(value) : toExpression(value, "select " + name)]),
          ),
        });
      },
      orderBy: (fn, direction = "asc") =>
        next({ orderBy: [...state.orderBy, { expression: toExpression(read(fn, "orderBy"), "orderBy"), direction }] }),
      limit: (count) => next({ limit: count }),
      value: (field, whenEmpty) => valueOf(handle)(field, whenEmpty),
    });
    return register(handle, state);
  };

  const from = (source) =>
    makeQuery({ kind: "select", from: readSource(source, "from(source)"), joins: [], where: [], groupBy: [], having: [], select: null, orderBy: [], limit: null });

  const many = (query) => {
    if (!queries.has(query)) fail("many(query) selects the rows of a query, such as many(from({ step: collections.workflowSteps }).where(...)).");
    const selected = Object.freeze({});
    manys.set(selected, { many: queries.get(query) });
    return selected;
  };

  const unionAll = (...branches) => {
    const state = {
      kind: "union",
      branches: branches.map((branch, index) => {
        if (!queries.has(branch)) fail("unionAll argument " + index + " is not a query.");
        return queries.get(branch);
      }),
    };
    const handle = Object.freeze({ value: (field, whenEmpty) => valueOf(handle)(field, whenEmpty) });
    return register(handle, state);
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
  const time = (offset) =>
    expression(
      { now: offset },
      {
        minus: (amount) => time(offset - duration(amount, "now.minus")),
        plus: (amount) => time(offset + duration(amount, "now.plus")),
      },
    );
  const intervals = (options) => {
    if (!isRecord(options)) fail("intervals({ every, since }) expects options such as { every: \"1 hour\", since: now.minus(\"24 hours\") }.");
    const since = expressions.get(options.since);
    if (!since || !("now" in since)) fail("intervals since is a time relative to now, such as now.minus(\"24 hours\").");
    const window = { every: duration(options.every, "intervals every"), since: since.now };
    const handle = Object.freeze({});
    windows.set(handle, window);
    // A chart's axis shows every interval, including those no row falls in.
    live.set(handle, () => window);
    return handle;
  };
  const bucket = (value, window) => {
    if (!windows.has(window)) fail("bucket(time, intervals) groups by intervals({ every, since }), such as intervals({ every: \"1 hour\", since: now.minus(\"24 hours\") }).");
    return expression({ bucket: toExpression(value, "bucket time"), ...windows.get(window) });
  };

  const operators = {};
  for (const name of functions) {
    operators[name] = (...args) =>
      expression({
        fn: name,
        args: args.map((arg, index) =>
          name === "inArray" && index === 1 && Array.isArray(arg) ? { value: arg } : toExpression(arg, name + " argument " + index),
        ),
      });
  }
  for (const name of aggregates) {
    operators[name] = (arg) => expression({ aggregate: name, arg: toExpression(arg, name + " argument") });
  }

  const context = Object.freeze({ collections, from, many, unionAll, now: time(0), intervals, bucket, ...operators });

  const define = (build) => {
    if (typeof build !== "function") fail("page.define(build) expects a function that returns the page's root ui element.");
    const root = build(context);
    const queryNames = new Map();
    const valueNames = new Map();
    const fileQueries = {};
    const fileValues = {};
    const nameQuery = (query) => {
      if (!queryNames.has(query)) {
        const name = "q" + queryNames.size;
        queryNames.set(query, name);
        fileQueries[name] = queries.get(query);
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
    return { version, queries: fileQueries, values: fileValues, spec: rendered.spec };
  };

  return Object.freeze({ define });
}`;

const builderConfig = JSON.stringify({
  functions: Object.keys(PAGE_QUERY_FUNCTIONS),
  aggregates: PAGE_QUERY_AGGREGATES,
  version: PAGE_DEFINITION_VERSION,
});

/** An expression that, given the guest's `ui` builder and its live values, evaluates to `page`. */
export const pageBuilderSource = `(${PAGE_BUILDER_SOURCE})(${builderConfig})`;
