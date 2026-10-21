import {
  PAGE_QUERY_AGGREGATES,
  PAGE_COLLECTIONS,
  PAGE_QUERY_FUNCTIONS,
  PAGE_LIMITS,
  pageFields,
  type PageCollection,
} from "./definition";

/**
 * Guest-side `page` builder. Queries record TanStack-style calls as the file's query JSON, so
 * fields are checked as they are read; `page.define` renders the interface with `ui.render`
 * and replaces each query or value in its props with the state path the page fills. The host
 * validates the saved file again with `parsePageDefinition`, because people edit it too.
 */
const PAGE_BUILDER_SOURCE = String.raw`({ collections, functions, aggregates, limits }) => (ui) => {
  const expressions = new WeakMap();
  const sources = new WeakMap();
  const queries = new WeakMap();
  const values = new WeakMap();
  const namePattern = /^[A-Za-z][A-Za-z0-9_]*$/;
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  const ignoredKey = (key) => typeof key !== "string" || key === "then" || key === "toJSON";

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
    if (queries.has(value)) fail(label + " is a query; queries feed props such as ui.table rows.");
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
  const sourceRefs = ({ alias, collection }) => {
    const fields = collections[collection];
    return new Proxy(Object.freeze({}), {
      get: (_, key) => {
        if (ignoredKey(key)) return undefined;
        const field = fields.find((candidate) => candidate.name === key);
        if (!field) {
          fail(alias + "." + key + ": " + collection + " has no \"" + key + "\" field. Fields: " + fields.map(({ name }) => name).join(", ") + ".");
        }
        return fieldRef([alias, key], field.type === "json");
      },
    });
  };
  const refsFor = (querySources) =>
    Object.freeze(Object.fromEntries(querySources.map((source) => [source.alias, sourceRefs(source)])));
  const callback = (fn, label) => {
    if (typeof fn !== "function") fail(label + " expects a callback such as ({ run }) => run.status.");
    return fn;
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
    const entries = isRecord(source) ? Object.entries(source) : [];
    if (entries.length !== 1) {
      fail(label + " expects one aliased collection, such as { run: collections.workflowInstances }.");
    }
    const [[alias, handle]] = entries;
    if (!namePattern.test(alias)) fail(label + " alias \"" + alias + "\" must start with a letter and use letters, digits, and _.");
    if (querySources.some((source) => source.alias === alias)) fail(label + " alias \"" + alias + "\" already names a source of this query.");
    const collection = sources.get(handle);
    if (!collection) fail(label + " " + alias + " must be one of collections, such as collections.workflowInstances.");
    return { alias, collection };
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
        const entries = isRecord(result) && !expressions.has(result) ? Object.entries(result) : [];
        if (entries.length === 0) fail("select returns an object of fields, such as ({ run }) => ({ status: run.status }).");
        for (const [name] of entries) {
          if (!namePattern.test(name)) fail("select field \"" + name + "\" must start with a letter and use letters, digits, and _.");
        }
        return next({ select: Object.fromEntries(entries.map(([name, value]) => [name, toExpression(value, "select " + name)])) });
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
      value: (field, whenEmpty) => {
        const fields = state.select ? Object.keys(state.select) : collections[state.from.collection].map(({ name }) => name);
        if (!fields.includes(field)) fail("value(field, whenEmpty) names no field of the query. Fields: " + fields.join(", ") + ".");
        if (typeof whenEmpty !== "string") fail("value(field, whenEmpty) shows whenEmpty, a string, while the query has no rows.");
        const value = Object.freeze({});
        values.set(value, { query: handle, field, whenEmpty });
        return value;
      },
    });
    queries.set(handle, state);
    return handle;
  };

  const from = (source) => {
    const parsed = readSource(source, "from(source)", []);
    return makeQuery({ sources: [parsed], from: parsed, joins: [], where: [], groupBy: [], having: [], select: null, orderBy: [], limit: null });
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
  const bucket = (value, options) => {
    if (!isRecord(options)) fail("bucket(time, { every, since }) expects options such as { every: \"1 hour\", since: now.minus(\"24 hours\") }.");
    const every = duration(options.every, "bucket every");
    const since = expressions.get(options.since);
    if (!since || !("now" in since) || since.now >= 0) fail("bucket since is a time before now, such as now.minus(\"24 hours\").");
    if (every < limits.minimumBucketMs) fail("bucket every is at least one minute.");
    if (Math.ceil(-since.now / every) > limits.buckets) fail("bucket covers at most " + limits.buckets + " intervals; widen every or shorten since.");
    return expression({ bucket: plainExpression(value, "bucket time"), every, since: since.now });
  };

  const context = Object.freeze({ collections: collectionHandles, from, now: time(0), bucket, ...operators });

  const serialize = (state) => {
    const label = "The query from " + state.from.collection;
    const grouped = state.groupBy.length > 0 || state.having.length > 0 || Object.values(state.select ?? {}).some(containsAggregate);
    if (state.limit !== null && state.orderBy.length === 0) fail(label + " sets a limit without orderBy; order it so the rows it keeps are deterministic.");
    if (state.select === null && state.joins.length > 0) fail(label + " joins collections; select the fields it shows.");
    if (state.select === null && grouped) fail(label + " is grouped; select its group fields and aggregates.");
    const { sources: _, ...query } = state;
    return query;
  };

  const define = (build) => {
    if (typeof build !== "function") fail("page.define(build) expects a function that returns the page's root ui element.");
    const rendered = ui.render(build(context));
    if (Object.keys(rendered.state).length > 0) fail("Pages show data; they do not collect ui.form input.");
    const queryNames = new Map();
    const valueNames = new Map();
    const fileQueries = {};
    const fileValues = {};
    const nameQuery = (query) => {
      if (!queryNames.has(query)) {
        if (queryNames.size >= limits.queries) fail("A page has at most " + limits.queries + " queries.");
        const name = "q" + queryNames.size;
        queryNames.set(query, name);
        fileQueries[name] = serialize(queries.get(query));
      }
      return queryNames.get(query);
    };
    const bind = (value, label) => {
      if (queries.has(value)) return { $state: "/data/" + nameQuery(value) };
      if (values.has(value)) {
        if (!valueNames.has(value)) {
          if (valueNames.size >= limits.values) fail("A page has at most " + limits.values + " values.");
          const name = "v" + valueNames.size;
          const { query, field, whenEmpty } = values.get(value);
          valueNames.set(value, name);
          fileValues[name] = { query: nameQuery(query), field, whenEmpty };
        }
        return { $state: "/values/" + valueNames.get(value) };
      }
      if (expressions.has(value)) fail(label + " is a query expression; pass a query, or query.value(field, whenEmpty), to props.");
      if (Array.isArray(value)) return value.map((item, index) => bind(item, label + "." + index));
      if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, label + "." + key)]));
      return value;
    };
    const elements = {};
    for (const [id, element] of Object.entries(rendered.spec.elements)) {
      elements[id] = { ...element, props: bind(element.props, id) };
    }
    return { version: 1, queries: fileQueries, values: fileValues, spec: { root: rendered.spec.root, elements } };
  };

  const preview = (definition) => {
    if (!isRecord(definition) || !isRecord(definition.queries) || !isRecord(definition.values) || !isRecord(definition.spec)) {
      fail("page.preview(definition) expects the result of page.define.");
    }
    return {
      version: 1,
      state: {
        data: Object.fromEntries(Object.keys(definition.queries).map((name) => [name, []])),
        values: Object.fromEntries(Object.entries(definition.values).map(([name, value]) => [name, value.whenEmpty])),
      },
      spec: definition.spec,
    };
  };

  return Object.freeze({ define, preview });
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
});

/** An expression that, given the guest's `ui` builder, evaluates to its `page` builder. */
export const pageBuilderSource = `(${PAGE_BUILDER_SOURCE})(${builderConfig})`;
