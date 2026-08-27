import { Checkbox } from "@base-ui/react/checkbox";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
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

import { ClientOnly } from "@/components/client-only";

import {
  getBackofficeJsonFormErrorMessages,
  translateBackofficeJsonFormError,
} from "./backoffice-json-form-errors";

const inputClassName =
  "min-h-12 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 text-[15px] text-[var(--bo-fg)] outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--bo-muted-2)] hover:border-[color:var(--bo-border-strong)] focus:border-[color:var(--bo-accent)] focus:bg-[var(--bo-panel)] focus:ring-2 focus:ring-[color:var(--bo-accent)]/15 disabled:cursor-not-allowed disabled:opacity-50";

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

function BackofficeControlField({
  children,
  description,
  errors,
  id,
  invalid,
  label,
  required,
}: {
  children: ReactNode;
  description: string | undefined;
  errors: string;
  id: string;
  invalid: boolean;
  label: string;
  required: boolean;
}) {
  return (
    <Field.Root invalid={invalid} className="space-y-2.5">
      <Field.Label
        htmlFor={id}
        className="flex items-baseline justify-between gap-3 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase"
      >
        <span>{label}</span>
        {required ? (
          <span className="shrink-0 text-[9px] tracking-[0.18em] text-[var(--bo-accent-fg)]">
            Required
          </span>
        ) : null}
      </Field.Label>
      {description ? (
        <Field.Description className="text-xs leading-5 text-[var(--bo-muted)]">
          {description}
        </Field.Description>
      ) : null}
      {children}
      <Field.Error match={invalid} className="text-xs leading-5 text-red-600 dark:text-red-400">
        {errors}
      </Field.Error>
    </Field.Root>
  );
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
  const {
    data,
    description,
    enabled,
    errors,
    id,
    label,
    path,
    required,
    schema,
    uischema,
    visible,
  } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  const inputId = `${id}-input`;
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
    id: inputId,
    disabled: !enabled,
    required,
    value: typeof data === "string" ? data : "",
    placeholder:
      typeof uischema.options?.placeholder === "string" ? uischema.options.placeholder : undefined,
    onBlur: markTouched,
  };

  return (
    <BackofficeControlField
      id={inputId}
      label={label}
      description={description}
      required={required === true}
      errors={errors}
      invalid={invalid}
    >
      {multiline ? (
        <textarea
          {...commonProps}
          rows={5}
          maxLength={schema.maxLength}
          className={`${inputClassName} min-h-32 resize-y py-3`}
          onChange={(event) => {
            markTouched();
            props.handleChange(path, event.target.value);
          }}
        />
      ) : (
        <Input
          {...commonProps}
          type={inputType}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          className={inputClassName}
          onValueChange={(value) => {
            markTouched();
            props.handleChange(path, value);
          }}
        />
      )}
    </BackofficeControlField>
  );
}

function BackofficeNumberControl(props: ControlProps) {
  const { data, description, enabled, errors, id, label, path, required, schema, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  const inputId = `${id}-input`;
  return (
    <BackofficeControlField
      id={inputId}
      label={label}
      description={description}
      required={required === true}
      errors={errors}
      invalid={touched && errors.length > 0}
    >
      <Input
        id={inputId}
        type="number"
        disabled={!enabled}
        required={required}
        value={typeof data === "number" ? data : ""}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : "any"}
        className={`${inputClassName} tabular-nums`}
        onBlur={markTouched}
        onValueChange={(value) => {
          markTouched();
          props.handleChange(path, value === "" ? undefined : Number(value));
        }}
      />
    </BackofficeControlField>
  );
}

function BackofficeBooleanControl(props: ControlProps) {
  const { data, description, enabled, errors, id, label, path, required, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  const inputId = `${id}-input`;
  const invalid = touched && errors.length > 0;
  return (
    <Field.Root invalid={invalid} className="space-y-2.5">
      <label
        htmlFor={inputId}
        className="flex min-h-14 cursor-pointer items-start gap-3 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-4 py-3.5 transition-[border-color,background-color] duration-150 hover:border-[color:var(--bo-border-strong)] hover:bg-[var(--bo-panel)]"
      >
        <Checkbox.Root
          id={inputId}
          checked={data === true}
          disabled={!enabled}
          required={required}
          onCheckedChange={(checked) => {
            markTouched();
            props.handleChange(path, checked);
          }}
          className="group mt-0.5 inline-flex size-5 shrink-0 items-center justify-center border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] text-[var(--bo-accent-fg)] transition-[border-color,background-color,scale] duration-150 outline-none focus-visible:border-[color:var(--bo-accent)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/20 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:border-[color:var(--bo-accent)] data-[checked]:bg-[var(--bo-accent-bg)]"
        >
          <Checkbox.Indicator>
            <Check className="size-3.5" strokeWidth={2} />
          </Checkbox.Indicator>
        </Checkbox.Root>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3 text-sm font-medium text-[var(--bo-fg)]">
            {label}
            {required ? (
              <span className="text-[9px] font-semibold tracking-[0.16em] text-[var(--bo-accent-fg)] uppercase">
                Required
              </span>
            ) : null}
          </span>
          {description ? (
            <span className="mt-1 block text-xs leading-5 text-[var(--bo-muted)]">
              {description}
            </span>
          ) : null}
        </span>
      </label>
      <Field.Error match={invalid} className="text-xs leading-5 text-red-600 dark:text-red-400">
        {errors}
      </Field.Error>
    </Field.Root>
  );
}

function BackofficeEnumControl(props: ControlProps & OwnPropsOfEnum) {
  const { data, description, enabled, errors, id, label, options, path, required, visible } = props;
  const { touched, markTouched } = useTouchedControl();
  if (!visible) {
    return null;
  }

  const inputId = `${id}-input`;
  const items = options ?? [];
  return (
    <BackofficeControlField
      id={inputId}
      label={label}
      description={description}
      required={required === true}
      errors={errors}
      invalid={touched && errors.length > 0}
    >
      <Select.Root
        id={inputId}
        items={items}
        value={data ?? null}
        disabled={!enabled}
        required={required}
        itemToStringLabel={(value) =>
          items.find((option) => Object.is(option.value, value))?.label ?? String(value)
        }
        itemToStringValue={(value) => String(value)}
        onValueChange={(value) => {
          markTouched();
          props.handleChange(path, value ?? undefined);
        }}
      >
        <Select.Trigger className="group flex min-h-12 w-full items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-left transition-[border-color,background-color,scale] duration-150 outline-none hover:border-[color:var(--bo-border-strong)] focus-visible:border-[color:var(--bo-accent)] focus-visible:bg-[var(--bo-panel)] focus-visible:ring-2 focus-visible:ring-[color:var(--bo-accent)]/15 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100">
          <Select.Value
            placeholder="Choose an option"
            className="min-w-0 flex-1 truncate px-4 text-[15px]"
          />
          <span className="flex size-10 shrink-0 items-center justify-center border-l border-[color:var(--bo-border)] text-[var(--bo-muted-2)] transition-colors duration-150 group-hover:text-[var(--bo-fg)]">
            <ChevronDown className="size-4" strokeWidth={1.5} />
          </span>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            sideOffset={6}
            align="start"
            className="z-50 w-[var(--anchor-width)] min-w-52"
          >
            <Select.Popup
              data-backoffice-root
              className="bo-popover-surface origin-[var(--transform-origin)] border border-[color:var(--bo-border-strong)] bg-[var(--bo-panel)] p-1 text-[var(--bo-fg)] transition-[opacity,transform] duration-150 data-[ending-style]:translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0"
            >
              {items.map((option) => (
                <Select.Item
                  key={`${option.label}-${String(option.value)}`}
                  value={option.value}
                  className="grid min-h-10 cursor-default grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 text-sm text-[var(--bo-muted)] transition-[background-color,color] duration-100 outline-none data-[highlighted]:bg-[var(--bo-panel-2)] data-[highlighted]:text-[var(--bo-fg)] data-[selected]:text-[var(--bo-fg)]"
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check className="size-3.5 text-[var(--bo-accent-fg)]" strokeWidth={2} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </BackofficeControlField>
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
    <fieldset className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 sm:p-5">
      {label ? (
        <legend className="px-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {label}
        </legend>
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
          className="min-h-28 border-l-2 border-[color:var(--bo-border)] bg-[var(--bo-panel-2)]"
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
        <div className="border-l-2 border-red-500 bg-red-500/5 px-3 py-2" role="alert">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-red-600 uppercase dark:text-red-400">
            Check the highlighted fields
          </p>
          <p className="mt-1 text-xs text-red-600/90 dark:text-red-400/90">
            {errorMessages.length === 1
              ? "1 field needs attention before this response can be submitted."
              : `${errorMessages.length} fields need attention before this response can be submitted.`}
          </p>
        </div>
      ) : null}

      {onSubmit ? (
        <div className="border-t border-[color:var(--bo-border)] pt-5">
          <button
            type="submit"
            disabled={submitting}
            className="min-h-12 w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-5 text-[11px] font-semibold tracking-[0.24em] text-[var(--bo-accent-fg)] uppercase transition-[border-color,background-color,scale] duration-150 hover:border-[color:var(--bo-accent-strong)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {submitting ? "Submitting…" : submitLabel}
          </button>
        </div>
      ) : null}
    </form>
  );
}
