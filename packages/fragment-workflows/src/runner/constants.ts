// Runner defaults and priority ordering for workflow task processing.

export const DEFAULT_MAX_INSTANCES = 10;
export const DEFAULT_MAX_STEPS = 1024;

export const PRIORITY_BY_KIND: Record<string, number> = {
  wake: 0,
  retry: 1,
  resume: 2,
  run: 3,
  gc: 4,
};
