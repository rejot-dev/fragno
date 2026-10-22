import {
  PAGE_COLLECTIONS,
  PAGE_DEFINITION_VERSION,
  PAGE_LIMITS,
  PAGE_QUERY_AGGREGATES,
  PAGE_QUERY_FUNCTIONS,
  pageFields,
  type PageCollection,
} from "./definition";

/**
 * Guest-side `page` builder. Queries record TanStack-style calls as the file's query JSON, so
 * fields are checked as they are read; `page.define` renders the interface with `ui.render`,
 * where each query or value a prop, condition, or repeat reads becomes the state path the page
 * fills. The host validates the saved file again with `parsePageDefinition`, because people edit
 * it too.
 */
const PAGE_BUILDER_SOURCE = String.raw`({ collections, functions, aggregates, limits, version }) => (ui, live) => {
  const expressions = new WeakMap();
  const sources = new WeakMap();
  const queries = new WeakMap();
  const manys = new WeakMap();
  const windows = new WeakMap();
  const namePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
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
  const containsAggregate = (ir) =>
    "aggregate" in ir ||
    ("fn" in ir && ir.args.some(containsAggregate)) ||
    ("bucket" in ir && containsAggregate(ir.bucket));
  const plainExpression = (value, label) => {
    const ir = toExpression(value, label);
    if (containsAggregate(ir)) fail(label + " cannot use aggregates; filter groups with having.");
    return ir;
  };

  const fieldRef = (path, json) => {
    const ir = { ref: path };
    if (!json) return expression(ir);
    // JSON fields read nested values, such as route.trigger.kind.
    const ref = new Proxy(Object.freeze({}), {
      get: (_, key) => (ignoredKey(key) ? undefined : fieldRef([...path, key], true)),
    });
    expressions.set(ref, ir);
    return ref;
  };
  const sourceRefs = ({ alias, label, fields }) =>
    new Proxy(Object.freeze({}), {
      get: (_, key) => {
        if (ignoredKey(key)) return undefined;
        const field = fields.find((candidate) => candidate.name === key);
        if (!field) {
          fail(alias + "." + key + ": " + label + " has no \"" + key + "\" field. Fields: " + fields.map(({ name }) => name).join(", ") + ".");
        }
        return fieldRef([alias, key], field.json);
      },
    });
  const refsFor = (querySources) =>
    Object.freeze(Object.fromEntries(querySources.map((source) => [source.alias, sourceRefs(source)])));
  const callback = (fn, label) => {
    if (typeof fn !== "function") fail(label + " expects a callback such as ({ run }) => run.status.");
    return fn;
  };

  /** The fields a query's rows carry; JSON fields read nested values in the queries that read it. */
  const fieldsOf = (state) => {
    if (state.kind === "union") return fieldsOf(state.branches[0]);
    if (state.select === null) return state.from.fields;
    return Object.entries(state.select).map(([name, selected]) => {
      if (manys.has(selected) || !("ref" in selected)) return { name, json: false };
      const [alias, field, ...nested] = selected.ref;
      const source = state.sources.find((candidate) => candidate.alias === alias);
      const json = nested.length > 0 || Boolean(source && source.fields.some((candidate) => candidate.name === field && candidate.json));
      return { name, json };
    });
  };

  const collectionHandles = new Proxy(
    Object.fromEntries(
      Object.keys(collections).map((name) => {
        const handle = Object.freeze({});
        sources.set(handle, name);
        return [name, handle];
      }),
    ),
    {
      get: (target, key) => {
        if (ignoredKey(key) || Object.hasOwn(target, key)) return target[key];
        return fail("collections." + key + " is not a page collection. Use one of: " + Object.keys(collections).join(", ") + ".");
      },
    },
  );
  const readSource = (source, label, querySources) => {
    const entries = isRecord(source) && !queries.has(source) ? Object.entries(source) : [];
    if (entries.length !== 1) {
      fail(label + " expects one aliased collection or query, such as { run: collections.workflowInstances }.");
    }
    const [[alias, handle]] = entries;
    if (!namePattern.test(alias)) fail(label + " alias \"" + alias + "\" must start with a letter and use letters, digits, and _.");
    if (querySources.some((source) => source.alias === alias)) fail(label + " alias \"" + alias + "\" already names a source of this query.");
    if (queries.has(handle)) {
      const query = queries.get(handle);
      return { alias, query, label: "the query under " + alias, fields: fieldsOf(query) };
    }
    const collection = sources.get(handle);
    if (!collection) fail(label + " " + alias + " must be one of collections, such as collections.workflowInstances, or a query.");
    const fields = collections[collection].map(({ name, type }) => ({ name, json: type === "json" }));
    return { alias, collection, label: collection, fields };
  };

  const valueOf = (handle, state) => (field, whenEmpty) => {
    const fields = fieldsOf(state).map(({ name }) => name);
    if (!fields.includes(field)) fail("value(field, whenEmpty) names no field of the query. Fields: " + fields.join(", ") + ".");
    const literal = whenEmpty === null || ["string", "boolean"].includes(typeof whenEmpty) || (typeof whenEmpty === "number" && Number.isFinite(whenEmpty));
    if (!literal) fail("value(field, whenEmpty) shows whenEmpty, a string, number, boolean, or null, while the query has no rows.");
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
    const refs = () => refsFor(state.sources);
    const next = (changes) => makeQuery({ ...state, ...changes });
    const join = (type, method) => (source, on) => {
      const joined = readSource(source, method + "(source, on)", state.sources);
      const querySources = [...state.sources, joined];
      const condition = toExpression(callback(on, method)(refsFor(querySources)), method + " on");
      if (!("fn" in condition) || condition.fn !== "eq" || !condition.args.every((arg) => "ref" in arg)) {
        fail(method + "(source, on) matches two fields: return eq(field, field), such as eq(run.id, step.instanceRef).");
      }
      return makeQuery({ ...state, sources: querySources, joins: [...state.joins, { type, source: joined, on: condition.args }] });
    };
    const handle = Object.freeze({
      join: join("inner", "join"),
      leftJoin: join("left", "leftJoin"),
      where: (fn) => next({ where: [...state.where, plainExpression(callback(fn, "where")(refs()), "where")] }),
      groupBy: (fn) => {
        const result = callback(fn, "groupBy")(refs());
        const keys = Array.isArray(result) ? result : [result];
        return next({ groupBy: [...state.groupBy, ...keys.map((key, index) => plainExpression(key, "groupBy key " + index))] });
      },
      having: (fn) => next({ having: [...state.having, toExpression(callback(fn, "having")(refs()), "having")] }),
      select: (fn) => {
        const result = callback(fn, "select")(refs());
        const entries = isRecord(result) && !expressions.has(result) && !queries.has(result) ? Object.entries(result) : [];
        if (entries.length === 0) fail("select returns an object of fields, such as ({ run }) => ({ status: run.status }).");
        for (const [name] of entries) {
          if (!namePattern.test(name)) fail("select field \"" + name + "\" must start with a letter and use letters, digits, and _.");
        }
        return next({
          select: Object.fromEntries(entries.map(([name, value]) => [name, manys.has(value) ? value : toExpression(value, "select " + name)])),
        });
      },
      orderBy: (fn, direction = "asc") => {
        if (direction !== "asc" && direction !== "desc") fail("orderBy direction is \"asc\" or \"desc\".");
        return next({ orderBy: [...state.orderBy, { expression: toExpression(callback(fn, "orderBy")(refs()), "orderBy"), direction }] });
      },
      limit: (count) => {
        if (!Number.isInteger(count) || count < 1 || count > limits.rowsPerQuery) {
          fail("limit expects a whole number 1-" + limits.rowsPerQuery + ".");
        }
        return next({ limit: count });
      },
      value: (field, whenEmpty) => valueOf(handle, state)(field, whenEmpty),
    });
    return register(handle, state);
  };

  const from = (source) => {
    const parsed = readSource(source, "from(source)", []);
    return makeQuery({ kind: "select", sources: [parsed], from: parsed, joins: [], where: [], groupBy: [], having: [], select: null, orderBy: [], limit: null });
  };

  const many = (query) => {
    if (!queries.has(query)) fail("many(query) selects the rows of a query, such as many(from({ step: collections.workflowSteps }).where(...)).");
    const selected = Object.freeze({});
    manys.set(selected, queries.get(query));
    return selected;
  };

  const unionAll = (...branches) => {
    if (branches.length < 2 || branches.length > limits.unionBranches) fail("unionAll(...queries) merges 2-" + limits.unionBranches + " queries.");
    const states = branches.map((branch, index) => {
      if (!queries.has(branch)) fail("unionAll argument " + index + " is not a query.");
      return queries.get(branch);
    });
    // TanStack names a union's rows by its branches' aliases, so they must differ.
    const aliasesOf = (state) => (state.kind === "union" ? state.branches.flatMap(aliasesOf) : state.sources.map(({ alias }) => alias));
    const aliases = states.flatMap(aliasesOf);
    const repeated = aliases.find((alias, index) => aliases.indexOf(alias) !== index);
    if (repeated) fail("unionAll(...queries) merges queries with distinct aliases; \"" + repeated + "\" names a source of more than one, such as from({ waiting: ... }) and from({ failed: ... }).");
    const names = (state) => fieldsOf(state).map(({ name }) => name).sort().join(", ");
    states.forEach((state, index) => {
      if (names(state) !== names(states[0])) {
        fail("unionAll(...queries) merges queries that select the same fields: query 0 selects " + names(states[0]) + "; query " + index + " selects " + names(state) + ".");
      }
    });
    const state = { kind: "union", branches: states };
    const handle = Object.freeze({ value: (field, whenEmpty) => valueOf(handle, state)(field, whenEmpty) });
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
    const every = duration(options.every, "intervals every");
    const since = expressions.get(options.since);
    if (!since || !("now" in since) || since.now >= 0) fail("intervals since is a time before now, such as now.minus(\"24 hours\").");
    if (every < limits.minimumBucketMs) fail("intervals every is at least one minute.");
    // Counts the interval now falls in too, as the host's mostIntervals does.
    if (Math.ceil(-since.now / every) + 1 > limits.buckets) fail("intervals covers at most " + limits.buckets + " intervals, counting the one now falls in; widen every or shorten since.");
    const handle = Object.freeze({});
    windows.set(handle, { every, since: since.now });
    // A chart's axis shows every interval, including those no row falls in.
    live.set(handle, () => ({ every, since: since.now }));
    return handle;
  };
  const bucket = (value, window) => {
    if (!windows.has(window)) fail("bucket(time, intervals) groups by intervals({ every, since }), such as intervals({ every: \"1 hour\", since: now.minus(\"24 hours\") }).");
    return expression({ bucket: plainExpression(value, "bucket time"), ...windows.get(window) });
  };

  const operators = {};
  for (const [name, [minimum, maximum]] of Object.entries(functions)) {
    operators[name] = (...args) => {
      if (args.length < minimum || (maximum !== null && args.length > maximum)) {
        fail(name + " takes " + (minimum === maximum ? minimum : minimum + " or more") + " arguments.");
      }
      return expression({
        fn: name,
        args: args.map((arg, index) => {
          const label = name + " argument " + index;
          if (name === "inArray" && index === 1 && Array.isArray(arg)) {
            if (arg.length > limits.listItems) fail(label + " lists at most " + limits.listItems + " values.");
            return {
              value: arg.map((item, itemIndex) => {
                const ir = toExpression(item, label + " item " + itemIndex);
                if (!("value" in ir)) fail(label + " lists plain values, such as [\"errored\", \"terminated\"].");
                return ir.value;
              }),
            };
          }
          return toExpression(arg, label);
        }),
      });
    };
  }
  for (const name of aggregates) {
    operators[name] = (arg) => expression({ aggregate: name, arg: plainExpression(arg, name + " argument") });
  }

  const context = Object.freeze({ collections: collectionHandles, from, many, unionAll, now: time(0), intervals, bucket, ...operators });

  /** The aliases an expression reads, so a query that reads rows it is not nested in fails here. */
  const refAliases = (ir) =>
    "ref" in ir ? [ir.ref[0]] : "fn" in ir ? ir.args.flatMap(refAliases) : "aggregate" in ir ? refAliases(ir.arg) : "bucket" in ir ? refAliases(ir.bucket) : [];

  const serialize = (state, outer, budget) => {
    budget.parts += 1;
    if (budget.parts > limits.queryParts) fail("A query is made of at most " + limits.queryParts + " queries, counting subqueries, many, and unionAll branches.");
    if (state.kind === "union") {
      return { kind: "union", branches: state.branches.map((branch) => serialize(branch, outer, budget)) };
    }
    const label = "The query from " + state.from.label;
    const aliases = state.sources.map(({ alias }) => alias);
    const shadowed = aliases.find((alias) => outer.includes(alias));
    if (shadowed) fail(label + " uses alias \"" + shadowed + "\", which also names the rows it is nested in; rename one.");
    const visible = [...outer, ...aliases];
    const selected = Object.values(state.select ?? {});
    const read = [
      ...state.joins.flatMap(({ on }) => on),
      ...state.where, ...state.groupBy, ...state.having,
      ...selected.filter((value) => !manys.has(value)),
      ...state.orderBy.map(({ expression: ir }) => ir),
    ].flatMap(refAliases);
    const stray = read.find((alias) => !visible.includes(alias));
    if (stray) fail(label + " reads " + stray + ", which is not one of its sources; read another query's rows with many(query) in its select.");
    const grouped = state.groupBy.length > 0 || state.having.length > 0 || selected.some((value) => !manys.has(value) && containsAggregate(value));
    if (state.limit !== null && state.orderBy.length === 0) fail(label + " sets a limit without orderBy; order it so the rows it keeps are deterministic.");
    if (state.select === null && state.joins.length > 0) fail(label + " joins collections; select the fields it shows.");
    if (state.select === null && grouped) fail(label + " is grouped; select its group fields and aggregates.");
    if (grouped && selected.some((value) => manys.has(value))) fail(label + " is grouped, so it cannot select many(...); group in a subquery and select from its rows, such as from({ workflow: grouped }).");
    if (grouped) {
      // As TanStack DB checks: a value equal to a group key is grouped, and so are fields of the rows a nested query sits in.
      const keys = state.groupBy.map((key) => JSON.stringify(key));
      const ungrouped = (ir) => {
        if (keys.includes(JSON.stringify(ir))) return null;
        if ("ref" in ir) return aliases.includes(ir.ref[0]) ? ir.ref.join(".") : null;
        if ("fn" in ir) return ir.args.map(ungrouped).find((field) => field !== null) ?? null;
        if ("bucket" in ir) return ungrouped(ir.bucket);
        return null;
      };
      const checked = [
        ...Object.entries(state.select ?? {}).filter(([, value]) => !manys.has(value)).map(([name, ir]) => ["select " + name, ir]),
        ...state.having.map((ir) => ["having", ir]),
      ];
      for (const [where, ir] of checked) {
        const field = ungrouped(ir);
        if (field) fail(label + " is grouped, but " + where + " reads " + field + ", which is neither grouped nor aggregated; add it to groupBy, or aggregate it, such as max(" + field + ").");
      }
    }
    // A source's rows do not depend on the rows around them.
    const source = ({ alias, collection, query }) => (query ? { alias, query: serialize(query, [], budget) } : { alias, collection });
    return {
      kind: "select",
      from: source(state.from),
      joins: state.joins.map((join) => ({ ...join, source: source(join.source) })),
      where: state.where,
      groupBy: state.groupBy,
      having: state.having,
      select: state.select === null ? null : Object.fromEntries(
        Object.entries(state.select).map(([name, value]) => [name, manys.has(value) ? { many: serialize(manys.get(value), visible, budget) } : value]),
      ),
      orderBy: state.orderBy,
      limit: state.limit,
    };
  };

  const define = (build) => {
    if (typeof build !== "function") fail("page.define(build) expects a function that returns the page's root ui element.");
    const root = build(context);
    const queryNames = new Map();
    const valueNames = new Map();
    const fileQueries = {};
    const fileValues = {};
    const nameQuery = (query) => {
      if (!queryNames.has(query)) {
        if (queryNames.size >= limits.queries) fail("A page has at most " + limits.queries + " queries.");
        const name = "q" + queryNames.size;
        queryNames.set(query, name);
        fileQueries[name] = serialize(queries.get(query), [], { parts: 0 });
      }
      return queryNames.get(query);
    };
    let rendered;
    binding = {
      query: nameQuery,
      value: (value, { query, field, whenEmpty }) => {
        if (!valueNames.has(value)) {
          if (valueNames.size >= limits.values) fail("A page has at most " + limits.values + " values.");
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
  collections: Object.fromEntries(
    (Object.keys(PAGE_COLLECTIONS) as PageCollection[]).map((collection) => [
      collection,
      pageFields(collection),
    ]),
  ),
  // JSON has no Infinity, so variadic functions have no maximum.
  functions: Object.fromEntries(
    Object.entries(PAGE_QUERY_FUNCTIONS).map(([name, { arity }]) => [
      name,
      [arity[0], Number.isFinite(arity[1]) ? arity[1] : null],
    ]),
  ),
  aggregates: PAGE_QUERY_AGGREGATES,
  limits: PAGE_LIMITS,
  version: PAGE_DEFINITION_VERSION,
});

/** An expression that, given the guest's `ui` builder and its live values, evaluates to `page`. */
export const pageBuilderSource = `(${PAGE_BUILDER_SOURCE})(${builderConfig})`;
