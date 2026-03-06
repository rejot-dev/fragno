type LogFields = Record<string, unknown>;
type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<PiLogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const DEFAULT_CONFIG: Required<PiLoggerConfig> = {
  enabled: false,
  level: "off",
};

export type PiLogLevel = "off" | "error" | "warn" | "info" | "debug";

export type PiLoggerConfig = {
  enabled?: boolean;
  level?: PiLogLevel;
};

export class PiLogger {
  static #enabled = DEFAULT_CONFIG.enabled;
  static #level: PiLogLevel = DEFAULT_CONFIG.level;

  static reset(): void {
    PiLogger.#enabled = DEFAULT_CONFIG.enabled;
    PiLogger.#level = DEFAULT_CONFIG.level;
  }

  static configure(config?: PiLoggerConfig): void {
    if (!config) {
      return;
    }
    if (config.enabled !== undefined) {
      PiLogger.#enabled = config.enabled;
    }
    if (config.level !== undefined) {
      PiLogger.#level = config.level;
    }
  }

  static enable(): void {
    PiLogger.#enabled = true;
  }

  static disable(): void {
    PiLogger.#enabled = false;
  }

  static setLogLevel(level: PiLogLevel): void {
    PiLogger.#level = level;
  }

  static debug(message: string, fields?: LogFields): void {
    PiLogger.#log("debug", message, fields);
  }

  static info(message: string, fields?: LogFields): void {
    PiLogger.#log("info", message, fields);
  }

  static warn(message: string, fields?: LogFields): void {
    PiLogger.#log("warn", message, fields);
  }

  static error(message: string, fields?: LogFields): void {
    PiLogger.#log("error", message, fields);
  }

  static #log(level: LogLevel, message: string, fields?: LogFields): void {
    if (!PiLogger.#enabled) {
      return;
    }
    if (LOG_LEVEL_PRIORITY[level] > LOG_LEVEL_PRIORITY[PiLogger.#level]) {
      return;
    }

    console[level](`[pi-fragment] ${message}`, {
      at: new Date().toISOString(),
      ...fields,
    });
  }
}
