export type ExecCodeModeResultDetails = {
  hasResult: boolean;
  logs: string[];
  result: unknown;
};

export function getExecCodeModeResultDetails(details: unknown): ExecCodeModeResultDetails {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { hasResult: false, logs: [], result: undefined };
  }

  const resultDetails = details as Record<string, unknown>;
  return {
    hasResult: "result" in resultDetails,
    logs: Array.isArray(resultDetails.logs)
      ? resultDetails.logs.filter((line): line is string => typeof line === "string")
      : [],
    result: resultDetails.result,
  };
}
