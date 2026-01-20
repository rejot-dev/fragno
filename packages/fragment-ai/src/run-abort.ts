const RUN_ABORT_CONTROLLERS = new Map<string, AbortController>();

export const registerRunAbortController = (runId: string, controller: AbortController) => {
  RUN_ABORT_CONTROLLERS.set(runId, controller);
  return () => {
    const existing = RUN_ABORT_CONTROLLERS.get(runId);
    if (existing === controller) {
      RUN_ABORT_CONTROLLERS.delete(runId);
    }
  };
};

export const abortRunInProcess = (runId: string) => {
  const controller = RUN_ABORT_CONTROLLERS.get(runId);
  if (!controller) {
    return false;
  }
  if (!controller.signal.aborted) {
    controller.abort();
  }
  return true;
};
