/// <reference path="/static/codemode/ui-catalog.d.ts" />
// The interface builder. ui-catalog.d.ts declares a ui.* function for every component; props are
// strict: pass only the listed fields and stay within each documented limit.

/** An interface element. Create it with a ui.* function and pass the root to ui.render. */
type BackofficeUiElement = { readonly type: string };
/** Reads UI state; form.bind and form.is cover forms, so authored code rarely needs it. */
type BackofficeUiStateRead = { $state: string };
/** Binds an editable component's value prop to one form field. Create it with form.bind. */
type BackofficeUiBinding = { readonly $bindState: string };
declare const backofficeUiLiveValue: unique symbol;
/** A live value, such as a page query's rows or a ui.each row's field; it renders as a state read. */
type BackofficeUiLive<TValue> = { readonly [backofficeUiLiveValue]: TValue };
/** A prop value: the literal, or a live value or state read in its place, at any depth. */
type BackofficeUiValue<TValue> =
  | BackofficeUiLive<TValue>
  | BackofficeUiStateRead
  | BackofficeUiBinding
  | (TValue extends readonly (infer TItem)[]
      ? BackofficeUiValue<TItem>[]
      : TValue extends object
        ? { [TKey in keyof TValue]: BackofficeUiValue<TValue[TKey]> }
        : TValue);
type BackofficeUiProps<TProps> = { [TKey in keyof TProps]: BackofficeUiValue<TProps[TKey]> };
/** One row of ui.each. Its fields, and their nested fields, are live values of the row. */
type BackofficeUiRow<TRow> = BackofficeUiLive<TRow> & BackofficeUiRowFields<NonNullable<TRow>>;
// Checks the row without null, which would otherwise widen a nullable row's fields to unknown.
type BackofficeUiRowFields<TRow> = TRow extends readonly unknown[]
  ? { readonly [index: number]: BackofficeUiRow<TRow[number]> }
  : TRow extends object
    ? { readonly [TKey in keyof TRow]-?: BackofficeUiRow<TRow[TKey]> }
    : unknown;
declare const backofficeUiRepeat: unique symbol;
/** A container's children repeated once per row; see ui.each. */
type BackofficeUiRepeat = { readonly [backofficeUiRepeat]: true };
declare const backofficeUiLiveCondition: unique symbol;
/** A condition on a live value; see ui.is. */
type BackofficeUiLiveCondition = { readonly [backofficeUiLiveCondition]: true };
type BackofficeUiComparison = {
  eq?: unknown;
  neq?: unknown;
  gt?: number | BackofficeUiStateRead;
  gte?: number | BackofficeUiStateRead;
  lt?: number | BackofficeUiStateRead;
  lte?: number | BackofficeUiStateRead;
  not?: true;
};
/** A visibility condition. Arrays and $and require every condition; $or requires one. */
type BackofficeUiCondition =
  | boolean
  | (BackofficeUiStateRead & BackofficeUiComparison)
  | BackofficeUiLiveCondition
  | BackofficeUiCondition[]
  | { $and: BackofficeUiCondition[] }
  | { $or: BackofficeUiCondition[] };
/** Collects one workflow event whose payload is the complete set of form fields. */
type BackofficeUiForm<TValues extends Record<string, unknown>> = {
  /** The event type. Await it with step.waitForEvent(name, { type: form.eventType }). */
  readonly eventType: string;
  /** Binds a field to an editable component's natural value prop. */
  bind(field: keyof TValues & string): BackofficeUiBinding;
  /** True while the field's current value matches the comparison; omit it to test truthiness. */
  is(field: keyof TValues & string, comparison?: BackofficeUiComparison): BackofficeUiCondition;
  /** The WorkflowEventButton that sends the complete form as the event payload. */
  submit(props: BackofficeUiFormSubmitProps): BackofficeUiElement;
};
/** The value of a result's top-level $ui field. */
type BackofficeUi = {
  version: 1;
  state: Record<string, unknown>;
  spec: { root: string; elements: Record<string, unknown> };
};

declare const ui: BackofficeUiComponents & {
  /**
   * A container's children, once per row of a live list such as a page query, or a row's nested
   * rows. Pass it as the children of ui.stack, ui.grid, or ui.section. render builds one row's
   * element from its fields, such as row.status; a nested ui.each reads only its own rows.
   */
  each<TRow>(
    rows: BackofficeUiLive<readonly TRow[]>,
    render: (row: BackofficeUiRow<TRow>) => BackofficeUiElement,
  ): BackofficeUiRepeat;
  /** True while a live value matches the comparison, such as ui.is(row.errored, { gt: 0 }); omit it to test truthiness. */
  is(
    value: BackofficeUiLive<unknown>,
    comparison?: BackofficeUiComparison,
  ): BackofficeUiLiveCondition;
  /** Shows the element only while the condition holds. */
  when(condition: BackofficeUiCondition, element: BackofficeUiElement): BackofficeUiElement;
  /** Declares the one form an interface may collect; initial names every field. */
  form<TValues extends Record<string, unknown>>(
    eventType: string,
    initial: TValues,
  ): BackofficeUiForm<TValues>;
  /** Renders the element tree, assigning element ids and form state. */
  render(root: BackofficeUiElement): BackofficeUi;
};
