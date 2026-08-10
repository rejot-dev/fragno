export function workflowRunErrorText({
  errorName,
  errorMessage,
}: {
  errorName: string | null;
  errorMessage: string | null;
}): string | null {
  if (errorName && errorMessage) {
    return `${errorName}: ${errorMessage}`;
  }
  return errorName ?? errorMessage;
}
