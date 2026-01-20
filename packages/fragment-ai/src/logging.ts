export interface AiLogger {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  debug(...data: unknown[]): void;
}

type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export const logWithLogger = (
  logger: AiLogger | undefined,
  level: LogLevel,
  payload: Record<string, unknown>,
) => {
  if (!logger) {
    return;
  }

  const handler =
    level === "info"
      ? logger.info
      : level === "warn"
        ? logger.warn
        : level === "error"
          ? logger.error
          : level === "debug"
            ? logger.debug
            : logger.log;

  if (handler) {
    handler.call(logger, payload);
  }
};
