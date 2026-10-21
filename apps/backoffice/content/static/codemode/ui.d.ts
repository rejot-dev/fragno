// Generated interface builder and component catalog. Props are strict: pass only the listed
// fields and stay within each documented limit.

/** An interface element. Create it with a ui.* function and pass the root to ui.render. */
type BackofficeUiElement = { readonly type: string };
/** Reads UI state; form.bind and form.is cover forms, so authored code rarely needs it. */
type BackofficeUiStateRead = { $state: string };
/** Binds an editable component's value prop to one form field. Create it with form.bind. */
type BackofficeUiBinding = { readonly $bindState: string };
declare const backofficeUiLiveValue: unique symbol;
/** A live value, such as a page query's rows; page.define binds it to the page's data. */
type BackofficeUiLive<TValue> = { readonly [backofficeUiLiveValue]: TValue };
type BackofficeUiProps<TProps> = {
  [TKey in keyof TProps]:
    | TProps[TKey]
    | BackofficeUiStateRead
    | BackofficeUiBinding
    | BackofficeUiLive<TProps[TKey]>;
};
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
type BackofficeUiFormSubmitProps = {
  /** 1-120 characters */
  label: string;
  variant?: "primary" | "danger";
  /** 1-500 characters */
  confirmation?: string;
};

declare const ui: {
  /** Builds Stack. Arranges generated Backoffice content vertically with a controlled gap. */
  stack(
    props: BackofficeUiProps<{
      gap: "sm" | "md" | "lg";
    }>,
    children: BackofficeUiElement[],
  ): BackofficeUiElement;
  /** Builds Grid. Arranges related report items in a responsive one-to-four-column grid. */
  grid(
    props: BackofficeUiProps<{
      columns: 1 | 2 | 3 | 4;
      gap: "sm" | "md" | "lg";
    }>,
    children: BackofficeUiElement[],
  ): BackofficeUiElement;
  /** Builds Section. Groups related report content in a square-edged Backoffice panel. */
  section(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      label?: string;
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
    children: BackofficeUiElement[],
  ): BackofficeUiElement;
  /** Builds Divider. Separates report sections with an optional compact label. */
  divider(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      label?: string;
    }>,
  ): BackofficeUiElement;
  /** Builds Heading. Displays a compact level-two, level-three, or level-four report heading. */
  heading(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      text: string;
      level?: 2 | 3 | 4;
    }>,
  ): BackofficeUiElement;
  /** Builds Text. Displays concise body text with default or muted emphasis. */
  text(
    props: BackofficeUiProps<{
      /** at most 4000 characters */
      text: string;
      tone?: "default" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds Code. Displays bounded source or diagnostic text in a read-only code block. */
  code(
    props: BackofficeUiProps<{
      /** at most 20000 characters */
      code: string;
      /** 1-80 characters */
      label?: string;
      /** 1-32 characters */
      language?: string;
    }>,
  ): BackofficeUiElement;
  /** Builds Image. Displays a PNG, JPEG, GIF, WebP, or SVG file from the current Backoffice scope. Use an absolute virtual file path (for example /workspace/screenshots/dashboard.png), not a URL or base64. Files remain private and are fetched with the viewer's authorization. */
  image(
    props: BackofficeUiProps<{
      /** at most 2048 characters */
      path: string;
      /** 1-500 characters */
      alt: string;
    }>,
  ): BackofficeUiElement;
  /** Builds Callout. Highlights a concise operational note with a semantic status tone. */
  callout(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      title: string;
      /** 1-2000 characters */
      text: string;
      tone: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds Metric. Displays one labeled operational metric with optional context and status tone. */
  metric(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** at most 240 characters */
      value: string;
      /** at most 240 characters */
      detail?: string;
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds Badge. Displays a compact semantic status label. */
  badge(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      label: string;
      tone: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds KeyValue. Displays compact label-value facts in a one- or two-column definition list. */
  keyValue(
    props: BackofficeUiProps<{
      columns: 1 | 2;
      /** at most 32 items */
      items: {
        /** 1-200 characters */
        key: string;
        /** 1-120 characters */
        label: string;
        /** at most 1000 characters */
        value: string;
      }[];
    }>,
  ): BackofficeUiElement;
  /** Builds List. Displays up to 64 operational records with optional semantic statuses. */
  list(
    props: BackofficeUiProps<{
      /** at most 64 items */
      items: {
        /** 1-200 characters */
        key: string;
        /** 1-200 characters */
        title: string;
        /** at most 1000 characters */
        detail?: string;
        /** 1-80 characters */
        status?: string;
        tone?: "info" | "live" | "waiting" | "failed" | "muted";
      }[];
    }>,
  ): BackofficeUiElement;
  /** Builds Table. Displays up to 64 text-only rows in a horizontally scrollable table. */
  table(
    props: BackofficeUiProps<{
      /** 1-160 characters */
      caption: string;
      /** 1-12 items */
      columns: {
        /** 1-80 characters */
        key: string;
        /** 1-120 characters */
        label: string;
        align?: "start" | "end";
      }[];
      /** at most 64 items; each item's values at most 2000 characters */
      rows: {
        [key: string]: string;
      }[];
    }>,
  ): BackofficeUiElement;
  /** Builds Progress. Displays completion from zero to one hundred percent with a semantic status tone. */
  progress(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** 0-100 */
      value: number;
      /** at most 240 characters */
      detail?: string;
      tone: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds TextInput. Collects a short text value. Bind value with form.bind(field) so edits update the form response. Set secret to true for sensitive values such as API keys. */
  textInput(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** at most 4000 characters */
      value: string;
      /** at most 240 characters */
      placeholder?: string;
      /** at most 500 characters */
      description?: string;
      required?: boolean;
      disabled?: boolean;
      secret?: boolean;
    }>,
  ): BackofficeUiElement;
  /** Builds TextArea. Collects a longer text value. Bind value with form.bind(field) so edits update the form response. */
  textArea(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** at most 12000 characters */
      value: string;
      /** at most 240 characters */
      placeholder?: string;
      /** at most 500 characters */
      description?: string;
      required?: boolean;
      disabled?: boolean;
      /** 2-12 */
      rows?: number;
    }>,
  ): BackofficeUiElement;
  /** Builds Select. Collects one value from a bounded list. Bind value with form.bind(field) so edits update the form response. */
  select(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** at most 500 characters */
      value: string;
      /** 1-50 items */
      options: {
        /** 1-120 characters */
        label: string;
        /** at most 500 characters */
        value: string;
      }[];
      /** at most 500 characters */
      description?: string;
      required?: boolean;
      disabled?: boolean;
    }>,
  ): BackofficeUiElement;
  /** Builds Checkbox. Collects a boolean choice. Bind checked with form.bind(field) so edits update the form response. */
  checkbox(
    props: BackofficeUiProps<{
      /** 1-240 characters */
      label: string;
      checked: boolean;
      /** at most 500 characters */
      description?: string;
      required?: boolean;
      disabled?: boolean;
    }>,
  ): BackofficeUiElement;
  /** Builds FileUpload. Uploads one private file as a prepared Upload draft. Use the current workflow context or a declared org, project, or personal scope. Bind value with form.bind(field); the field receives one serializable prepared-upload reference. */
  fileUpload(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      scope:
        | {
            kind: "current";
          }
        | {
            kind: "org";
            /** at least 1 characters */
            orgId: string;
          }
        | {
            kind: "user";
            /** at least 1 characters */
            userId: string;
          }
        | {
            kind: "app";
            owner:
              | {
                  kind: "org";
                  /** at least 1 characters */
                  orgId: string;
                }
              | {
                  kind: "user";
                  /** at least 1 characters */
                  userId: string;
                };
            /** at least 1 characters */
            appId: string;
          }
        | {
            kind: "project";
            owner:
              | {
                  kind: "org";
                  /** at least 1 characters */
                  orgId: string;
                }
              | {
                  kind: "user";
                  /** at least 1 characters */
                  userId: string;
                }
              | {
                  kind: "app";
                  owner:
                    | {
                        kind: "org";
                        /** at least 1 characters */
                        orgId: string;
                      }
                    | {
                        kind: "user";
                        /** at least 1 characters */
                        userId: string;
                      };
                  /** at least 1 characters */
                  appId: string;
                };
            /** at least 1 characters */
            projectId: string;
          };
      value: {
        kind: "prepared-upload";
        scope:
          | {
              kind: "org";
              /** at least 1 characters */
              orgId: string;
            }
          | {
              kind: "user";
              /** at least 1 characters */
              userId: string;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    /** at least 1 characters */
                    orgId: string;
                  }
                | {
                    kind: "user";
                    /** at least 1 characters */
                    userId: string;
                  };
              /** at least 1 characters */
              appId: string;
            }
          | {
              kind: "project";
              owner:
                | {
                    kind: "org";
                    /** at least 1 characters */
                    orgId: string;
                  }
                | {
                    kind: "user";
                    /** at least 1 characters */
                    userId: string;
                  }
                | {
                    kind: "app";
                    owner:
                      | {
                          kind: "org";
                          /** at least 1 characters */
                          orgId: string;
                        }
                      | {
                          kind: "user";
                          /** at least 1 characters */
                          userId: string;
                        };
                    /** at least 1 characters */
                    appId: string;
                  };
              /** at least 1 characters */
              projectId: string;
            };
        /** 1-240 characters */
        uploadId: string;
        /** 1-120 characters */
        provider: string;
        /** 1-1024 characters */
        fileKey: string;
        /** 1-500 characters */
        filename: string;
        /** 0-9007199254740991 */
        sizeBytes: number;
        /** 1-240 characters */
        contentType: string;
        /** ISO 8601 datetime string. */
        expiresAt: string;
      } | null;
      /** at most 500 characters */
      description?: string;
      /** 1-20 items; each item 1-120 characters */
      accept?: string[];
      /** at most 9007199254740991 */
      maxSizeBytes?: number;
      required?: boolean;
      disabled?: boolean;
    }>,
  ): BackofficeUiElement;
  /** Builds WorkflowEventButton. Sends payload to the current workflow waitForEvent step. Use only in durable workflow step UI. For forms, use form.submit(props), which sets eventType and the complete form payload; build this button directly only to send a fixed payload with eventType set to the exact awaited type. */
  workflowEventButton(
    props: BackofficeUiProps<{
      /** 1-120 characters */
      label: string;
      /** 1-128 characters */
      eventType: string;
      payload: unknown;
      variant?: "primary" | "danger";
      /** 1-500 characters */
      confirmation?: string;
    }>,
  ): BackofficeUiElement;
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
