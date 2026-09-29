export type WorkerRuntime = Readonly<{
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
}>;

export type WorkerBundle = Readonly<{
  mainModule: string;
  modules: Readonly<Record<string, string>>;
  runtime: WorkerRuntime;
}>;

export type CreateWorkerBundleInput = {
  mainModule: string;
  modules: Readonly<Record<string, string>>;
  runtime: {
    compatibilityDate: string;
    compatibilityFlags?: readonly string[];
  };
};

const normalizeCompatibilityDate = (value: string) => {
  const compatibilityDate = value.trim();
  const parsedDate = new Date(`${compatibilityDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(compatibilityDate) ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== compatibilityDate
  ) {
    throw new Error("Worker compatibility date must be a valid YYYY-MM-DD date.");
  }
  return compatibilityDate;
};

const normalizeCompatibilityFlags = (flags: readonly string[] | undefined) => {
  const normalizedFlags = flags ?? [];
  for (const flag of normalizedFlags) {
    if (!flag.trim() || flag !== flag.trim()) {
      throw new Error("Worker compatibility flags must be non-empty and trimmed.");
    }
  }
  return [...new Set(normalizedFlags)];
};

export const createWorkerBundle = (input: CreateWorkerBundleInput): WorkerBundle => {
  const mainModule = input.mainModule.trim();
  if (!mainModule) {
    throw new Error("Worker bundle requires a main module.");
  }
  if (!(mainModule in input.modules)) {
    throw new Error(`Worker bundle main module '${mainModule}' is missing.`);
  }
  for (const moduleName of Object.keys(input.modules)) {
    if (!moduleName.trim() || moduleName !== moduleName.trim()) {
      throw new Error("Worker bundle module names must be non-empty and trimmed.");
    }
  }

  return {
    mainModule,
    modules: { ...input.modules },
    runtime: {
      compatibilityDate: normalizeCompatibilityDate(input.runtime.compatibilityDate),
      compatibilityFlags: normalizeCompatibilityFlags(input.runtime.compatibilityFlags),
    },
  };
};
