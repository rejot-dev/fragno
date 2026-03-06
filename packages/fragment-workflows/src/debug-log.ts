type LogFields = Record<string, unknown>;
type LogFieldsInput = LogFields | (() => LogFields);

type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_LEVEL_PRIORITY: Record<WorkflowsLogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_CONFIG: Required<WorkflowsLoggerConfig> = {
  enabled: false,
  level: "off",
};

export type WorkflowsLogLevel = "off" | "error" | "warn" | "info" | "debug";

export type WorkflowsLoggerConfig = {
  enabled?: boolean;
  level?: WorkflowsLogLevel;
};

export class WorkflowsLogger {
  static #enabled = DEFAULT_CONFIG.enabled;
  static #level: WorkflowsLogLevel = DEFAULT_CONFIG.level;

  static configure(config?: WorkflowsLoggerConfig): void {
    if (!config) {
      return;
    }
    if (config.enabled !== undefined) {
      WorkflowsLogger.#enabled = config.enabled;
    }
    if (config.level !== undefined) {
      WorkflowsLogger.#level = config.level;
    }
  }

  static enable(): void {
    WorkflowsLogger.#enabled = true;
  }

  static disable(): void {
    WorkflowsLogger.#enabled = false;
  }

  static setLogLevel(level: WorkflowsLogLevel): void {
    WorkflowsLogger.#level = level;
  }

  static debug(message: string, fields?: LogFieldsInput): void {
    WorkflowsLogger.#log("debug", message, fields);
  }

  static info(message: string, fields?: LogFieldsInput): void {
    WorkflowsLogger.#log("info", message, fields);
  }

  static warn(message: string, fields?: LogFieldsInput): void {
    WorkflowsLogger.#log("warn", message, fields);
  }

  static error(message: string, fields?: LogFieldsInput): void {
    WorkflowsLogger.#log("error", message, fields);
  }

  static #log(level: LogLevel, message: string, fields?: LogFieldsInput): void {
    if (!WorkflowsLogger.#enabled) {
      return;
    }
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[WorkflowsLogger.#level]) {
      return;
    }

    console[level](`[workflows] ${message}`, {
      at: new Date().toISOString(),
      ...WorkflowsLogger.#resolveFields(fields),
    });
  }

  static #resolveFields(fields?: LogFieldsInput): LogFields {
    if (!fields) {
      return {};
    }
    return typeof fields === "function" ? fields() : fields;
  }
}
