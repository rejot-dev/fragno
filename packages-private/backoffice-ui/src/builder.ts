import { normalizeCode } from "@fragno-dev/codemode/runtime-api";

import { backofficeUiComponentDefinitions } from "./catalog";
import { pageBuilderSource } from "./pages/builder";
import { BACKOFFICE_UI_LIMITS } from "./result";

/** Each catalog component is built by its lower-camel name, e.g. `ui.keyValue` builds `KeyValue`. */
export const backofficeUiBuilderComponents = Object.entries(backofficeUiComponentDefinitions).map(
  ([type, definition]) => ({
    functionName: `${type.charAt(0).toLowerCase()}${type.slice(1)}`,
    type,
    acceptsChildren: (definition.slots as readonly string[]).includes("default"),
    // Named slots are passed as props that hold elements, such as `expanded: [...]`.
    slots: (definition.slots as readonly string[]).filter((slot) => slot !== "default"),
  }),
);

/**
 * Guest-side `ui` builder. It only composes the tree, assigns positional element ids, and wires
 * forms; the host validates the rendered `$ui` with `parseBackofficeUiResult`, so props stay
 * unchecked here. Element ids encode their tree position ("root.1.0") so host validation errors
 * point at the authored call.
 *
 * `live` maps handles to the JSON they render as, such as a page query to its `$state` read.
 * `ui.render` resolves them wherever they sit, so names assigned while rendering, like a page's
 * query names, reach props, conditions, and repeats alike.
 */
const BACKOFFICE_UI_BUILDER_SOURCE = String.raw`({ components, maxElements }) => (live) => {
  const elements = new WeakSet();
  const bindingForms = new WeakMap();
  const submitForms = new WeakMap();
  const repeats = new WeakMap();
  const itemScopes = new WeakMap();
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  const ignoredKey = (key) => typeof key !== "string" || key === "then" || key === "toJSON";
  const element = (type, props, children, visible, repeat, slots) => {
    const created = Object.freeze({ type, props, children, visible, repeat, slots });
    elements.add(created);
    return created;
  };
  const requireElement = (value, label) => {
    if (!elements.has(value)) {
      fail(label + " must be created by a ui.* function, received " + describe(value) + ".");
    }
    return value;
  };
  const pointerSegment = (segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1");

  // A row's fields read the item of the ui.each that made the row; json-render reads only the
  // innermost item, so render rejects a row read inside another ui.each.
  const itemRef = (path, scope) => {
    const ref = new Proxy(Object.freeze({}), {
      get: (_, key) => (ignoredKey(key) ? undefined : itemRef(path === "" ? pointerSegment(key) : path + "/" + pointerSegment(key), scope)),
    });
    itemScopes.set(ref, scope);
    live.set(ref, (renderScope) => {
      if (renderScope !== scope) {
        fail("row" + (path === "" ? "" : "." + path.replace(/\//g, ".")) + " is read outside the ui.each that made the row, or inside a nested ui.each; select the fields each nested row needs into its rows.");
      }
      return { $item: path };
    });
    return ref;
  };
  const resolve = (value, scope) => {
    if (live.has(value)) return resolve(live.get(value)(scope), scope);
    if (Array.isArray(value)) return value.map((item) => resolve(item, scope));
    if (isRecord(value) && !elements.has(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, scope)]));
    }
    return value;
  };
  const stateRead = (value, scope, label) => {
    const read = resolve(value, scope);
    if (isRecord(read) && typeof read.$state === "string" && Object.keys(read).length === 1) return read;
    if (isRecord(read) && typeof read.$item === "string" && Object.keys(read).length === 1) return read;
    return fail(label + " expects a live value, such as a page query or a row's field; received " + describe(value) + ".");
  };

  const ui = {};
  for (const component of components) {
    const name = "ui." + component.functionName;
    ui[component.functionName] = (...args) => {
      const given = args[0];
      if (!isRecord(given) || live.has(given)) {
        fail(name + " expects a props object, received " + describe(given) + ".");
      }
      const props = { ...given };
      const slots = {};
      for (const slot of component.slots) {
        if (!Object.hasOwn(props, slot)) continue;
        if (!Array.isArray(props[slot])) {
          fail(name + " " + slot + " expects an array of ui elements, received " + describe(props[slot]) + ".");
        }
        slots[slot] = props[slot].map((child, index) => requireElement(child, name + " " + slot + " " + index));
        delete props[slot];
      }
      if (!component.acceptsChildren) {
        if (args.length > 1) fail(name + " does not accept children.");
        return element(component.type, props, [], null, null, slots);
      }
      const children = args[1];
      if (repeats.has(children)) {
        return element(component.type, props, [repeats.get(children).template], null, repeats.get(children), slots);
      }
      if (!Array.isArray(children)) {
        fail(name + "(props, children) expects a children array or ui.each(rows, render), received " + describe(children) + ".");
      }
      children.forEach((child, index) => requireElement(child, name + " child " + index));
      return element(component.type, props, [...children], null, null, slots);
    };
  }

  ui.each = (rows, render) => {
    if (typeof render !== "function") {
      fail("ui.each(rows, render) expects render, a function from a row to an element.");
    }
    const scope = Object.freeze({});
    const template = requireElement(render(itemRef("", scope)), "ui.each(rows, render) render's result");
    const repeat = Object.freeze({ rows, template, scope });
    repeats.set(repeat, repeat);
    return repeat;
  };

  ui.is = (value, comparison = {}) => {
    if (!isRecord(comparison)) {
      fail("ui.is(value, comparison) expects a comparison object such as { eq: value }.");
    }
    const unknown = Object.keys(comparison).filter((key) => !["eq", "neq", "gt", "gte", "lt", "lte", "not"].includes(key));
    if (unknown.length > 0) {
      fail("ui.is(value, comparison) compares with eq, neq, gt, gte, lt, lte, or not; remove " + unknown.join(", ") + ".");
    }
    const condition = Object.freeze({});
    live.set(condition, (scope) => ({ ...stateRead(value, scope, "ui.is(value, comparison) value"), ...resolve(comparison, scope) }));
    return condition;
  };

  ui.when = (condition, target) => {
    requireElement(target, "ui.when(condition, element) element");
    const visible = target.visible === null ? condition : { $and: [target.visible, condition] };
    const shown = element(target.type, target.props, target.children, visible, target.repeat, target.slots);
    if (submitForms.has(target)) submitForms.set(shown, submitForms.get(target));
    return shown;
  };

  ui.form = (eventType, initial) => {
    if (typeof eventType !== "string" || eventType.length === 0) {
      fail("ui.form(eventType, initial) expects the awaited event type as a non-empty string.");
    }
    if (!isRecord(initial)) {
      fail("ui.form(eventType, initial) expects an object of initial field values, received " + describe(initial) + ".");
    }
    const form = { eventType, initial: structuredClone(initial) };
    const fieldPath = (field, method) => {
      if (typeof field !== "string" || !Object.hasOwn(form.initial, field)) {
        fail("form." + method + "(" + JSON.stringify(field) + ") names no field of ui.form(" + JSON.stringify(eventType) + "); declare it in the initial values.");
      }
      return "/response/" + pointerSegment(field);
    };
    return Object.freeze({
      eventType,
      bind: (field) => {
        const binding = Object.freeze({ $bindState: fieldPath(field, "bind") });
        bindingForms.set(binding, form);
        return binding;
      },
      is: (field, comparison = {}) => {
        if (!isRecord(comparison)) {
          fail("form.is(field, comparison) expects a comparison object such as { eq: value }.");
        }
        return { $state: fieldPath(field, "is"), ...comparison };
      },
      submit: (props) => {
        if (!isRecord(props)) {
          fail("form.submit expects a props object, received " + describe(props) + ".");
        }
        if (Object.hasOwn(props, "eventType") || Object.hasOwn(props, "payload")) {
          fail("form.submit sets eventType and payload itself; pass label, variant, or confirmation.");
        }
        const button = element("WorkflowEventButton", { ...props, eventType, payload: { $state: "/response" } }, [], null, null, {});
        submitForms.set(button, form);
        return button;
      },
    });
  };

  ui.render = (root) => {
    requireElement(root, "ui.render(root) root");
    const specElements = {};
    const forms = new Set();
    const submittedForms = new Set();
    let count = 0;
    const visit = (node, id, scope) => {
      count += 1;
      // Reused subtrees expand per use, so stop before an exponential tree exhausts the guest.
      if (count > maxElements) fail("ui.render exceeds the " + maxElements + "-element limit.");
      const props = {};
      for (const [key, value] of Object.entries(node.props)) {
        const form = bindingForms.get(value);
        if (form) forms.add(form);
        props[key] = form ? { $bindState: value.$bindState } : resolve(value, scope);
      }
      const submitted = submitForms.get(node);
      if (submitted) {
        forms.add(submitted);
        submittedForms.add(submitted);
      }
      // Insert before visiting children so the spec, and its validation errors, read root-first.
      const rendered = { type: node.type, props, children: [] };
      if (node.visible !== null) rendered.visible = resolve(node.visible, scope);
      specElements[id] = rendered;
      if (node.repeat !== null) {
        // The repeated element reads its rows from the item around it; its child reads each row.
        const read = stateRead(node.repeat.rows, scope, "ui.each(rows, render) rows");
        rendered.repeat = { statePath: read.$state ?? { $item: read.$item } };
        rendered.children = [visit(node.repeat.template, id + ".0", node.repeat.scope)];
      } else {
        rendered.children = node.children.map((child, index) => visit(child, id + "." + index, scope));
      }
      const slotNames = Object.keys(node.slots);
      if (slotNames.length > 0) {
        rendered.slots = Object.fromEntries(
          slotNames.map((slot) => [slot, node.slots[slot].map((child, index) => visit(child, id + "." + slot + "." + index, scope))]),
        );
      }
      return id;
    };
    visit(root, "root", null);
    if (forms.size > 1) {
      fail("ui.render found " + forms.size + " forms; one interface collects one ui.form.");
    }
    const [form] = forms;
    if (form && !submittedForms.has(form)) {
      fail("ui.form(" + JSON.stringify(form.eventType) + ") has bound fields but no form.submit(...) button.");
    }
    return {
      version: 1,
      state: form ? { response: structuredClone(form.initial) } : {},
      spec: { root: "root", elements: specElements },
    };
  };

  return Object.freeze(ui);
}`;

const builderConfig = JSON.stringify({
  components: backofficeUiBuilderComponents,
  maxElements: BACKOFFICE_UI_LIMITS.elements,
});

/** An expression for the `ui` and `page` builders, which share the handles `ui.render` resolves. */
export const backofficeUiBuildersSource = `((live) => ((ui) => ({ ui, page: ${pageBuilderSource}(ui, live) }))((${BACKOFFICE_UI_BUILDER_SOURCE})(${builderConfig})(live)))(new WeakMap())`;

/**
 * Gives a codemode program the `ui` and `page` builders without changing the guest protocol.
 * Saved modules it imports have their own scope, so they reach the builders as globals.
 */
export function withBackofficeUiBuilder(code: string) {
  const program = normalizeCode(code.trim().replace(/;*$/u, ""));
  // The program starts on the first line so compiler diagnostics keep the author's line numbers.
  return `((builders) => (globalThis.ui = builders.ui, globalThis.page = builders.page, ${program}\n))(${backofficeUiBuildersSource})`;
}

// Saved modules live under /static and /workspace, so these paths cannot collide with them.
const UI_BUILDER_GLOBALS_MODULE = "/__backoffice__/ui-builder-globals.js";
const UI_BUILDER_ENTRY_MODULE = "/__backoffice__/ui-builder-entry.js";

/**
 * Gives a module program the `ui` and `page` builders as globals. A module evaluates its imports in
 * order, so the builders exist before any of the program's modules run.
 */
export function withBackofficeUiBuilderModule(program: {
  entry: string;
  modules: Record<string, string>;
}) {
  return {
    entry: UI_BUILDER_ENTRY_MODULE,
    modules: {
      ...program.modules,
      [UI_BUILDER_GLOBALS_MODULE]: `const builders = ${backofficeUiBuildersSource};\nglobalThis.ui = builders.ui;\nglobalThis.page = builders.page;\n`,
      [UI_BUILDER_ENTRY_MODULE]: `import ${JSON.stringify(UI_BUILDER_GLOBALS_MODULE)};\nexport { default } from ${JSON.stringify(program.entry)};\n`,
    },
  };
}
