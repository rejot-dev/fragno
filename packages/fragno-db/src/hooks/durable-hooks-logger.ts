type LogFields = Record<string, unknown>;
type LogFieldsInput = LogFields | (() => LogFields);

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_PRIORITY: Record<DurableHooksLogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_SCOPE: Required<DurableHooksLoggerConfig> = {
  enabled: true,
  level: "warn",
};

export type DurableHooksLogLevel = "off" | "error" | "warn" | "info" | "debug";

export type DurableHooksLoggerConfig = {
  enabled?: boolean;
  level?: DurableHooksLogLevel;
};

type LoggerScope = Required<DurableHooksLoggerConfig>;

type LogOptions = {
  namespace?: string;
  fields?: LogFieldsInput;
};

export class DurableHooksLogger {
  static #defaultScope: LoggerScope = { ...DEFAULT_SCOPE };
  static #namespaceScopes = new Map<string, LoggerScope>();

  static configure(config?: DurableHooksLoggerConfig, namespace?: string): void {
    if (!config) {
      return;
    }

    const target = namespace
      ? (DurableHooksLogger.#namespaceScopes.get(namespace) ?? {
          ...DurableHooksLogger.#defaultScope,
        })
      : { ...DurableHooksLogger.#defaultScope };

    if (config.enabled !== undefined) {
      target.enabled = config.enabled;
    }
    if (config.level !== undefined) {
      target.level = config.level;
    }

    if (namespace) {
      DurableHooksLogger.#namespaceScopes.set(namespace, target);
      return;
    }

    DurableHooksLogger.#defaultScope = target;
  }

  static enable(namespace?: string): void {
    DurableHooksLogger.configure({ enabled: true }, namespace);
  }

  static disable(namespace?: string): void {
    DurableHooksLogger.configure({ enabled: false }, namespace);
  }

  static setLogLevel(level: DurableHooksLogLevel, namespace?: string): void {
    DurableHooksLogger.configure({ level }, namespace);
  }

  static debug(message: string, options?: LogOptions): void {
    DurableHooksLogger.#log("debug", message, options);
  }

  static info(message: string, options?: LogOptions): void {
    DurableHooksLogger.#log("info", message, options);
  }

  static warn(message: string, options?: LogOptions): void {
    DurableHooksLogger.#log("warn", message, options);
  }

  static error(message: string, options?: LogOptions): void {
    DurableHooksLogger.#log("error", message, options);
  }

  static toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  static #log(level: LogLevel, message: string, options?: LogOptions): void {
    const scope = DurableHooksLogger.#resolveScope(options?.namespace);
    if (!scope.enabled) {
      return;
    }
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[scope.level]) {
      return;
    }

    const fields = DurableHooksLogger.#resolveFields(options?.fields);
    const payload = {
      at: new Date().toISOString(),
      ...(options?.namespace ? { namespace: options.namespace } : {}),
      ...fields,
    };

    console[level](`[fragno-db] ${message}`, payload);
  }

  static #resolveScope(namespace?: string): LoggerScope {
    if (!namespace) {
      return DurableHooksLogger.#defaultScope;
    }
    return DurableHooksLogger.#namespaceScopes.get(namespace) ?? DurableHooksLogger.#defaultScope;
  }

  static #resolveFields(fields?: LogFieldsInput): LogFields {
    if (!fields) {
      return {};
    }
    return typeof fields === "function" ? fields() : fields;
  }
}
