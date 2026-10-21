import { normalizeCode } from "@fragno-dev/codemode/runtime-api";

import { pageBuilderSource } from "@/artifacts/pages/builder";

import { backofficeUiComponentDefinitions } from "./catalog";
import { BACKOFFICE_UI_LIMITS } from "./result";

/** Each catalog component is built by its lower-camel name, e.g. `ui.keyValue` builds `KeyValue`. */
export const backofficeUiBuilderComponents = Object.entries(backofficeUiComponentDefinitions).map(
  ([type, definition]) => ({
    functionName: `${type.charAt(0).toLowerCase()}${type.slice(1)}`,
    type,
    acceptsChildren: (definition.slots as readonly string[]).includes("default"),
  }),
);

/**
 * Guest-side `ui` builder. It only composes the tree, assigns positional element ids, and wires
 * forms; the host validates the rendered `$ui` with `parseBackofficeUiResult`, so props stay
 * unchecked here. Element ids encode their tree position ("root.1.0") so host validation errors
 * point at the authored call.
 */
const BACKOFFICE_UI_BUILDER_SOURCE = String.raw`({ components, maxElements }) => {
  const elements = new WeakSet();
  const bindingForms = new WeakMap();
  const submitForms = new WeakMap();
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const describe = (value) => (Array.isArray(value) ? "an array" : value === null ? "null" : typeof value);
  const fail = (message) => {
    throw new TypeError(message);
  };
  const element = (type, props, children, visible) => {
    const created = Object.freeze({ type, props, children, visible });
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

  const ui = {};
  for (const component of components) {
    const name = "ui." + component.functionName;
    ui[component.functionName] = (...args) => {
      const props = args[0];
      if (!isRecord(props)) {
        fail(name + " expects a props object, received " + describe(props) + ".");
      }
      if (!component.acceptsChildren) {
        if (args.length > 1) fail(name + " does not accept children.");
        return element(component.type, props, [], null);
      }
      const children = args[1];
      if (!Array.isArray(children)) {
        fail(name + "(props, children) expects a children array, received " + describe(children) + ".");
      }
      children.forEach((child, index) => requireElement(child, name + " child " + index));
      return element(component.type, props, [...children], null);
    };
  }

  ui.when = (condition, target) => {
    requireElement(target, "ui.when(condition, element) element");
    const visible = target.visible === null ? condition : { $and: [target.visible, condition] };
    const shown = element(target.type, target.props, target.children, visible);
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
        const button = element("WorkflowEventButton", { ...props, eventType, payload: { $state: "/response" } }, [], null);
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
    const visit = (node, id) => {
      count += 1;
      // Reused subtrees expand per use, so stop before an exponential tree exhausts the guest.
      if (count > maxElements) fail("ui.render exceeds the " + maxElements + "-element limit.");
      const props = {};
      for (const [key, value] of Object.entries(node.props)) {
        const form = bindingForms.get(value);
        if (form) forms.add(form);
        props[key] = form ? { $bindState: value.$bindState } : value;
      }
      const submitted = submitForms.get(node);
      if (submitted) {
        forms.add(submitted);
        submittedForms.add(submitted);
      }
      // Insert before visiting children so the spec, and its validation errors, read root-first.
      const rendered = { type: node.type, props, children: [] };
      if (node.visible !== null) rendered.visible = node.visible;
      specElements[id] = rendered;
      rendered.children = node.children.map((child, index) => visit(child, id + "." + index));
      return id;
    };
    visit(root, "root");
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

/**
 * Gives a codemode program the `ui` and `page` builders without changing the guest protocol.
 * Saved modules it imports have their own scope, so they reach the builders as globals.
 */
export function withBackofficeUiBuilder(code: string) {
  const program = normalizeCode(code.trim().replace(/;*$/u, ""));
  // The program starts on the first line so compiler diagnostics keep the author's line numbers.
  return `((ui) => ((page) => (globalThis.ui = ui, globalThis.page = page, ${program}\n))(${pageBuilderSource}(ui)))((${BACKOFFICE_UI_BUILDER_SOURCE})(${builderConfig}))`;
}
