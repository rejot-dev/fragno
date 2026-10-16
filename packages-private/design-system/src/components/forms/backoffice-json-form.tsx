import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SubmitEvent,
} from "react";

import {
  and,
  createAjv,
  findUISchema,
  Generate,
  isBooleanControl,
  isEnumControl,
  isIntegerControl,
  isNumberControl,
  isObjectControl,
  isStringControl,
  optionIs,
  rankWith,
  uiTypeIs,
  type ControlProps,
  type JsonFormsRendererRegistryEntry,
  type JsonSchema,
  type LayoutProps,
  type Middleware,
  type OwnPropsOfEnum,
  type RankedTester,
  type StatePropsOfControlWithDetail,
  type UISchemaElement,
} from "@jsonforms/core";
import {
  JsonForms,
  JsonFormsDispatch,
  withJsonFormsControlProps as jsonFormsControlProps,
  withJsonFormsDetailProps as jsonFormsDetailProps,
  withJsonFormsEnumProps as jsonFormsEnumProps,
  withJsonFormsLayoutProps as jsonFormsLayoutProps,
} from "@jsonforms/react";

import { Button } from "../button";
import { ClientOnly } from "../client-only";
import { CheckboxField, Field } from "../field";
import { Icon } from "../icon";
import { Input } from "../input";
import { Select } from "../select";
import { TextArea } from "../text-area";
import {
  getBackofficeJsonFormErrorMessages,
  translateBackofficeJsonFormError,
} from "./backoffice-json-form-errors";

function withJsonFormsControlProps(component: ComponentType<ControlProps>) {
  return jsonFormsControlProps(component);
}

function withJsonFormsEnumProps(component: ComponentType<ControlProps & OwnPropsOfEnum>) {
  return jsonFormsEnumProps(component);
}

function withJsonFormsLayoutProps<T extends LayoutProps>(component: ComponentType<T>) {
  return jsonFormsLayoutProps(component);
}

function withJsonFormsDetailProps(component: ComponentType<StatePropsOfControlWithDetail>) {
  return jsonFormsDetailProps(component);
}

function useTouchedControl() {
  const [touched, setTouched] = useState(false);
  return {
    touched,
    markTouched: () => {
      setTouched(true);
    },
  };
}

function BackofficeTextControl(props: ControlProps) {
  const { data, description, enabled, errors, label, path, required, schema, uischema, visible } =
    props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  const multiline = uischema.options?.multi === true;
  const invalid = touched && errors.length > 0;
  const inputType =
    schema.format === "email"
      ? "email"
      : schema.format === "date"
        ? "date"
        : schema.format === "time"
          ? "time"
          : schema.format === "date-time"
            ? "datetime-local"
            : "text";
  const commonProps = {
    disabled: !enabled,
    required,
    value: typeof data === "string" ? data : "",
    placeholder:
      typeof uischema.options?.placeholder === "string" ? uischema.options.placeholder : undefined,
    onBlur: markTouched,
  };

  return (
    <Field
      density="comfortable"
      label={label}
      description={description}
      required={required === true}
      error={invalid ? errors : null}
    >
      {multiline ? (
        <TextArea
          {...commonProps}
          density="comfortable"
          rows={5}
          maxLength={schema.maxLength}
          onChange={(event) => {
            markTouched();
            props.handleChange(path, event.target.value);
          }}
        />
      ) : (
        <Input
          {...commonProps}
          density="comfortable"
          type={inputType}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          className="w-full"
          onChange={(event) => {
            markTouched();
            props.handleChange(path, event.target.value);
          }}
        />
      )}
    </Field>
  );
}

function BackofficeNumberControl(props: ControlProps) {
  const { data, description, enabled, errors, label, path, required, schema, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  return (
    <Field
      density="comfortable"
      label={label}
      description={description}
      required={required === true}
      error={touched && errors.length > 0 ? errors : null}
    >
      <Input
        density="comfortable"
        type="number"
        disabled={!enabled}
        required={required}
        value={typeof data === "number" ? data : ""}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : "any"}
        className="w-full tabular-nums"
        onBlur={markTouched}
        onChange={(event) => {
          markTouched();
          const value = event.target.value;
          props.handleChange(path, value === "" ? undefined : Number(value));
        }}
      />
    </Field>
  );
}

function BackofficeBooleanControl(props: ControlProps) {
  const { data, description, enabled, errors, label, path, required, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  return (
    <CheckboxField
      density="comfortable"
      label={label}
      description={description}
      required={required === true}
      disabled={!enabled}
      checked={data === true}
      error={touched && errors.length > 0 ? errors : null}
      onCheckedChange={(checked) => {
        markTouched();
        props.handleChange(path, checked);
      }}
    />
  );
}

function BackofficeEnumControl(props: ControlProps & OwnPropsOfEnum) {
  const { data, description, enabled, errors, label, options, path, required, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  return (
    <Field
      density="comfortable"
      label={label}
      description={description}
      required={required === true}
      error={touched && errors.length > 0 ? errors : null}
    >
      <Select
        density="comfortable"
        options={options ?? []}
        value={data ?? null}
        placeholder="Choose an option"
        disabled={!enabled}
        required={required === true}
        onValueChange={(value) => {
          markTouched();
          props.handleChange(path, value ?? undefined);
        }}
      />
    </Field>
  );
}

function createKeyedUISchemaElements(elements: readonly UISchemaElement[]) {
  // UI schema elements have no required ID, so content identity preserves control state on reorder.
  const identityCounts = new Map<string, number>();

  return elements.map((element) => {
    const identity = JSON.stringify(element) ?? element.type;
    const occurrence = identityCounts.get(identity) ?? 0;
    identityCounts.set(identity, occurrence + 1);
    return { element, key: `${identity}:${occurrence}` };
  });
}

function BackofficeVerticalLayout({
  cells,
  enabled,
  path,
  renderers,
  schema,
  uischema,
  visible,
}: LayoutProps) {
  if (!visible || !("elements" in uischema)) {
    return null;
  }

  return (
    <div className="space-y-6">
      {createKeyedUISchemaElements(uischema.elements).map(({ element, key }) => (
        <JsonFormsDispatch
          key={key}
          cells={cells}
          enabled={enabled}
          path={path}
          renderers={renderers}
          schema={schema}
          uischema={element}
        />
      ))}
    </div>
  );
}

function BackofficeHorizontalLayout({
  cells,
  enabled,
  path,
  renderers,
  schema,
  uischema,
  visible,
}: LayoutProps) {
  if (!visible || !("elements" in uischema)) {
    return null;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {createKeyedUISchemaElements(uischema.elements).map(({ element, key }) => (
        <JsonFormsDispatch
          key={key}
          cells={cells}
          enabled={enabled}
          path={path}
          renderers={renderers}
          schema={schema}
          uischema={element}
        />
      ))}
    </div>
  );
}

function BackofficeGroupLayout({
  cells,
  enabled,
  label,
  path,
  renderers,
  schema,
  uischema,
  visible,
}: LayoutProps) {
  if (!visible || !("elements" in uischema)) {
    return null;
  }

  return (
    <fieldset className="rounded-[6px] border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 sm:p-5">
      {label ? (
        <legend className="px-1.5 text-sm font-semibold text-[var(--bo-fg)]">{label}</legend>
      ) : null}
      <div className="space-y-6">
        {createKeyedUISchemaElements(uischema.elements).map(({ element, key }) => (
          <JsonFormsDispatch
            key={key}
            cells={cells}
            enabled={enabled}
            path={path}
            renderers={renderers}
            schema={schema}
            uischema={element}
          />
        ))}
      </div>
    </fieldset>
  );
}

function BackofficeObjectControl({
  cells,
  enabled,
  label,
  path,
  renderers,
  rootSchema,
  schema,
  uischema,
  uischemas,
  visible,
}: StatePropsOfControlWithDetail) {
  const detailUiSchema = useMemo(
    () =>
      findUISchema(
        uischemas ?? [],
        schema,
        uischema.scope,
        path,
        () =>
          !path
            ? Generate.uiSchema(schema, "VerticalLayout", undefined, rootSchema)
            : { ...Generate.uiSchema(schema, "Group", undefined, rootSchema), label },
        uischema,
        rootSchema,
      ),
    [label, path, rootSchema, schema, uischema, uischemas],
  );

  if (!visible) {
    return null;
  }

  return (
    <JsonFormsDispatch
      cells={cells}
      enabled={enabled}
      path={path}
      renderers={renderers}
      schema={schema}
      uischema={detailUiSchema}
    />
  );
}

const backofficeTextAreaControlTester: RankedTester = rankWith(
  5,
  and(isStringControl, optionIs("multi", true)),
);
const backofficeEnumControlTester: RankedTester = rankWith(4, isEnumControl);
const backofficeBooleanControlTester: RankedTester = rankWith(3, isBooleanControl);
const backofficeIntegerControlTester: RankedTester = rankWith(3, isIntegerControl);
const backofficeNumberControlTester: RankedTester = rankWith(2, isNumberControl);
const backofficeTextControlTester: RankedTester = rankWith(1, isStringControl);
const backofficeObjectControlTester: RankedTester = rankWith(2, isObjectControl);
const backofficeVerticalLayoutTester: RankedTester = rankWith(1, uiTypeIs("VerticalLayout"));
const backofficeHorizontalLayoutTester: RankedTester = rankWith(1, uiTypeIs("HorizontalLayout"));
const backofficeGroupLayoutTester: RankedTester = rankWith(1, uiTypeIs("Group"));

const BackofficeTextControlContext = withJsonFormsControlProps(BackofficeTextControl);
const BackofficeNumberControlContext = withJsonFormsControlProps(BackofficeNumberControl);
const BackofficeBooleanControlContext = withJsonFormsControlProps(BackofficeBooleanControl);
const BackofficeEnumControlContext = withJsonFormsEnumProps(BackofficeEnumControl);
const BackofficeObjectControlContext = withJsonFormsDetailProps(BackofficeObjectControl);
const BackofficeVerticalLayoutContext = withJsonFormsLayoutProps(BackofficeVerticalLayout);
const BackofficeHorizontalLayoutContext = withJsonFormsLayoutProps(BackofficeHorizontalLayout);
const BackofficeGroupLayoutContext = withJsonFormsLayoutProps(BackofficeGroupLayout);

const backofficeJsonFormRenderers: JsonFormsRendererRegistryEntry[] = [
  { tester: backofficeTextAreaControlTester, renderer: BackofficeTextControlContext },
  { tester: backofficeEnumControlTester, renderer: BackofficeEnumControlContext },
  { tester: backofficeBooleanControlTester, renderer: BackofficeBooleanControlContext },
  { tester: backofficeIntegerControlTester, renderer: BackofficeNumberControlContext },
  { tester: backofficeNumberControlTester, renderer: BackofficeNumberControlContext },
  { tester: backofficeTextControlTester, renderer: BackofficeTextControlContext },
  { tester: backofficeObjectControlTester, renderer: BackofficeObjectControlContext },
  { tester: backofficeVerticalLayoutTester, renderer: BackofficeVerticalLayoutContext },
  { tester: backofficeHorizontalLayoutTester, renderer: BackofficeHorizontalLayoutContext },
  { tester: backofficeGroupLayoutTester, renderer: BackofficeGroupLayoutContext },
];

type BackofficeJsonFormProps = {
  initialData?: Record<string, unknown>;
  readOnly?: boolean;
  schema: JsonSchema;
  submitLabel?: string;
  submitting?: boolean;
  uiSchema?: UISchemaElement | null;
  onSubmit?: (data: Record<string, unknown>) => Promise<void> | void;
};

/** Renders a JSON Schema form with Backoffice Base UI controls and JSON-safe submission data. */
export function BackofficeJsonForm(props: BackofficeJsonFormProps) {
  // JSON Forms compiles schemas with Ajv, which cannot execute in the Cloudflare Worker SSR runtime.
  return (
    <ClientOnly
      fallback={
        <div
          role="status"
          aria-label="Loading form preview"
          className="min-h-28 rounded-[6px] bg-[var(--bo-panel-2)]"
        />
      }
    >
      {() => <BackofficeJsonFormClient {...props} />}
    </ClientOnly>
  );
}

function BackofficeJsonFormClient({
  initialData = {},
  readOnly = false,
  schema,
  submitLabel = "Submit response",
  submitting = false,
  uiSchema,
  onSubmit,
}: BackofficeJsonFormProps) {
  const [data, setData] = useState<Record<string, unknown>>(initialData);
  const [errorMessages, setErrorMessages] = useState<string[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const dataRef = useRef(initialData);
  const ajv = useMemo(() => createAjv(), []);
  const captureJsonFormsState = useCallback<Middleware>((state, action, defaultReducer) => {
    const nextState = defaultReducer(state, action);
    dataRef.current = (nextState.data ?? {}) as Record<string, unknown>;
    return nextState;
  }, []);

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const valid = ajv.validate(schema, dataRef.current);
    const submissionErrors = valid ? [] : getBackofficeJsonFormErrorMessages(ajv.errors);
    setErrorMessages(submissionErrors);
    setSubmitAttempted(true);
    if (!onSubmit || !valid) {
      return;
    }
    void onSubmit(dataRef.current);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-6">
      <JsonForms
        schema={schema}
        uischema={uiSchema ?? undefined}
        ajv={ajv}
        data={data}
        readonly={readOnly || submitting}
        renderers={backofficeJsonFormRenderers}
        i18n={{ translateError: translateBackofficeJsonFormError }}
        middleware={captureJsonFormsState}
        onChange={({ data: nextData, errors }) => {
          const nextFormData = (nextData ?? {}) as Record<string, unknown>;
          const nextErrorMessages = getBackofficeJsonFormErrorMessages(errors);
          dataRef.current = nextFormData;
          setData(nextFormData);
          setErrorMessages(nextErrorMessages);
        }}
      />

      {submitAttempted && errorMessages.length > 0 ? (
        <div
          className="rounded-[4px] bg-[var(--bo-failed-bg)] px-3 py-2.5 text-[var(--bo-failed)]"
          role="alert"
        >
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Icon name="alert-circle" className="size-4 shrink-0" strokeWidth={1.75} />
            Check the highlighted fields
          </p>
          <p className="mt-1 pl-6 text-xs">
            {errorMessages.length === 1
              ? "1 field needs attention before this response can be submitted."
              : `${errorMessages.length} fields need attention before this response can be submitted.`}
          </p>
        </div>
      ) : null}

      {onSubmit ? (
        <div className="border-t border-[color:var(--bo-border)] pt-5">
          <Button type="submit" variant="solid" disabled={submitting} className="min-h-12 w-full">
            {submitting ? "Submitting…" : submitLabel}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
