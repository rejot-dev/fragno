// Generated from the component catalog; ui.d.ts declares the rest of the ui builder.

type BackofficeUiFormSubmitProps = {
  /** 1-120 characters */
  label: string;
  variant?: "primary" | "danger";
  /** 1-500 characters */
  confirmation?: string;
};

type BackofficeUiComponents = {
  /** Builds Stack. Arranges generated Backoffice content in a column, or in a row such as an icon beside text; justify between pushes a row's last child to its end, such as a time. Gap xl spaces a page's panels. */
  stack(
    props: BackofficeUiProps<{
      gap: "sm" | "md" | "lg" | "xl";
      direction?: "column" | "row";
      justify?: "start" | "between";
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds Grid. Arranges related report items in a responsive one-to-four-column grid, or main-side: a wide column beside a narrow one on large screens, such as details beside connections. Gap xl spaces a page's panels. */
  grid(
    props: BackofficeUiProps<{
      columns: 1 | 2 | 3 | 4 | "main-side";
      gap: "sm" | "md" | "lg" | "xl";
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds Section. Groups related report content in a square-edged Backoffice panel. */
  section(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      label?: string;
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds Panel. A titled region of a page: its title over a rule, then its content, and optionally a closing link to where everything it summarizes lives. Pages are built of panels; put a rowList or content in each. */
  panel(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      title: string;
      link?: {
        /** 1-120 characters */
        label: string;
        to:
          | {
              kind: "run";
              /** 1-200 characters */
              workflowName: string;
              /** 1-200 characters */
              instanceId: string;
            }
          | {
              kind: "route";
              /** 1-200 characters */
              id: string;
            }
          | {
              kind: "connection";
              /** 1-200 characters */
              id: string;
            }
          | {
              kind: "integrations";
            }
          | {
              kind: "agents";
            };
      };
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds PanelTable. A panel of rows that share columns, such as ui.each(rows, (row) => ui.panelTableRow(...)). Its title heads the first column, which holds each row's title; columns label the cells after it. Shows empty under its header while there are no rows. */
  panelTable(
    props: BackofficeUiProps<{
      /** 1-80 characters */
      title: string;
      /** at most 11 items */
      columns: {
        /** 1-80 characters */
        label: string;
        align?: "start" | "end";
      }[];
      /** 1-200 characters */
      empty: string;
      link?: {
        /** 1-120 characters */
        label: string;
        to:
          | {
              kind: "run";
              /** 1-200 characters */
              workflowName: string;
              /** 1-200 characters */
              instanceId: string;
            }
          | {
              kind: "route";
              /** 1-200 characters */
              id: string;
            }
          | {
              kind: "connection";
              /** 1-200 characters */
              id: string;
            }
          | {
              kind: "integrations";
            }
          | {
              kind: "agents";
            };
      };
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds PanelTableRow. One row of a panelTable: its title, linked when to is set, then one child per column, such as sparkBars, a number, or a row of a badge and a relativeTime. */
  panelTableRow(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      title: string;
      to?:
        | {
            kind: "run";
            /** 1-200 characters */
            workflowName: string;
            /** 1-200 characters */
            instanceId: string;
          }
        | {
            kind: "route";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "connection";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "integrations";
          }
        | {
            kind: "agents";
          };
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds RowList. Lists rows divided by rules, such as ui.each(rows, (row) => ui.listRow(...)). Shows empty in their place when there are no rows, or nothing without it; row lists that follow one another read as one list. */
  rowList(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      empty?: string;
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
  ): BackofficeUiElement;
  /** Builds ListRow. One row of a rowList: an icon, its title, a muted detail line, and its children at the end, such as a relativeTime, badge, or sparkBars. With to, the whole row is a link, so its children hold no links. A tone puts the icon on a tile in that tone, for rows that ask for something. */
  listRow(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      title: string;
      to?:
        | {
            kind: "run";
            /** 1-200 characters */
            workflowName: string;
            /** 1-200 characters */
            instanceId: string;
          }
        | {
            kind: "route";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "connection";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "integrations";
          }
        | {
            kind: "agents";
          };
      /** at most 500 characters */
      detail?: string;
      icon?:
        | "activity"
        | "alert-circle"
        | "alert-triangle"
        | "bell"
        | "calendar"
        | "check"
        | "check-circle"
        | "clock"
        | "edit-3"
        | "inbox"
        | "info"
        | "link"
        | "mail"
        | "message-square"
        | "pause-circle"
        | "play-circle"
        | "user"
        | "users"
        | "x-circle"
        | "zap";
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
    children: BackofficeUiElement[] | BackofficeUiRepeat,
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
      value: string | number;
      /** at most 240 characters */
      detail?: string;
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds Number. Displays a number rounded for reading: integer, decimal with up to two fraction digits, or percent of a ratio, so 0.92 shows 92%; null shows a dash. */
  number(
    props: BackofficeUiProps<{
      value: number | null;
      format: "integer" | "decimal" | "percent";
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
  /** Builds Icon. Displays a small icon that marks a row's kind, such as alert-triangle for a failure, in a status tone; muted without one. */
  icon(
    props: BackofficeUiProps<{
      name:
        | "activity"
        | "alert-circle"
        | "alert-triangle"
        | "bell"
        | "calendar"
        | "check"
        | "check-circle"
        | "clock"
        | "edit-3"
        | "inbox"
        | "info"
        | "link"
        | "mail"
        | "message-square"
        | "pause-circle"
        | "play-circle"
        | "user"
        | "users"
        | "x-circle"
        | "zap";
      tone?: "info" | "live" | "waiting" | "failed" | "muted";
    }>,
  ): BackofficeUiElement;
  /** Builds Link. Links to a workflow run (workflowName is the runner's internal name), an automation route, an integration connection, or the integrations or agents of the current scope. */
  link(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      label: string;
      to:
        | {
            kind: "run";
            /** 1-200 characters */
            workflowName: string;
            /** 1-200 characters */
            instanceId: string;
          }
        | {
            kind: "route";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "connection";
            /** 1-200 characters */
            id: string;
          }
        | {
            kind: "integrations";
          }
        | {
            kind: "agents";
          };
    }>,
  ): BackofficeUiElement;
  /** Builds RelativeTime. Displays how long ago or until an ISO 8601 time, such as 3m ago or in 2h, and keeps it current; null shows a dash. */
  relativeTime(
    props: BackofficeUiProps<{
      time: string | null;
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
  /** Builds Table. Displays up to 64 rows in a horizontally scrollable table. Each column shows its key's value as text: JSON as JSON, and null as an empty cell. */
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
      /** at most 64 items */
      rows: {
        [key: string]: unknown;
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
  /** Builds SparkBars. Displays a word-sized bar per axis category, sized by the rows' value field, for trends in rows and lists. label describes the series for screen readers. */
  sparkBars(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      label: string;
      /** at most 1000 items */
      rows: {
        [key: string]: unknown;
      }[];
      axis: {
        /** 1-80 characters */
        field: string;
        intervals?: {
          /** 60000-9007199254740991 */
          every: number;
          since: number;
        };
      };
      /** 1-80 characters */
      value: string;
    }>,
  ): BackofficeUiElement;
  /** Builds BarChart. Displays a bar per axis category, stacked by the rows' series field and sized by their value field, with a legend of series totals. The 6 largest series show; the rest stack as Other. */
  barChart(
    props: BackofficeUiProps<{
      /** 1-200 characters */
      label: string;
      /** at most 1000 items */
      rows: {
        [key: string]: unknown;
      }[];
      axis: {
        /** 1-80 characters */
        field: string;
        intervals?: {
          /** 60000-9007199254740991 */
          every: number;
          since: number;
        };
      };
      /** 1-80 characters */
      value: string;
      /** 1-80 characters */
      series: string;
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
};
