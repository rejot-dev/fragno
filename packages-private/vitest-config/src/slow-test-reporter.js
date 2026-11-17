const SLOW_AFTER_MS = 60_000;
const REPORT_EVERY_MS = 30_000;

/**
 * Names the test files and tests that have run for over a minute, every 30 seconds, and says when
 * none runs but the run has not ended. Reporters print a file once it finishes, and Turbo in CI
 * prints a task once it ends, so without this a stalled run shows nothing until it is cancelled.
 *
 * A plain object of closures rather than a class: `mergeConfig` copies config objects into plain
 * ones, which keeps own properties but drops a prototype's methods.
 *
 * @returns {import("vitest/node").Reporter}
 */
export function slowTestReporter() {
  /** @type {import("vitest/node").Vitest | undefined} */
  let vitest;
  /** @type {Map<string, { moduleId: string; label: string; startedAt: number }>} */
  const running = new Map();
  let idleSince = Date.now();
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;

  /** @param {string} id */
  function finish(id) {
    running.delete(id);
    if (running.size === 0) {
      idleSince = Date.now();
    }
  }

  function report() {
    const now = Date.now();
    const modulesWithRunningTests = new Set(
      [...running]
        .filter(([id, entry]) => id !== entry.moduleId)
        .map(([, entry]) => entry.moduleId),
    );
    for (const [id, { label, startedAt }] of running) {
      // A running test names its file; a file alone is stuck in its imports or hooks.
      if (modulesWithRunningTests.has(id)) {
        continue;
      }
      if (now - startedAt >= SLOW_AFTER_MS) {
        vitest?.logger.log(`still running after ${seconds(now - startedAt)}: ${label}`);
      }
    }
    if (running.size === 0 && now - idleSince >= SLOW_AFTER_MS) {
      vitest?.logger.log(
        `no test has run for ${seconds(now - idleSince)}, but the test run has not ended`,
      );
    }
  }

  return {
    onInit(instance) {
      vitest = instance;
    },
    onTestRunStart() {
      running.clear();
      idleSince = Date.now();
      clearInterval(timer);
      timer = setInterval(report, REPORT_EVERY_MS);
      // Reporting never keeps the process alive.
      timer.unref();
    },
    // A module is queued once a worker starts loading it, so a stall in its imports shows too.
    onTestModuleQueued(testModule) {
      running.set(testModule.id, {
        moduleId: testModule.id,
        label: projectPrefix(testModule.project) + testModule.relativeModuleId,
        startedAt: Date.now(),
      });
    },
    onTestModuleEnd(testModule) {
      finish(testModule.id);
    },
    onTestCaseReady(testCase) {
      running.set(testCase.id, {
        moduleId: testCase.module.id,
        label: `${projectPrefix(testCase.project)}${testCase.module.relativeModuleId} > ${testCase.fullName}`,
        startedAt: Date.now(),
      });
    },
    onTestCaseResult(testCase) {
      finish(testCase.id);
    },
    onTestRunEnd() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

/** @param {import("vitest/node").TestProject} project */
function projectPrefix(project) {
  return project.name ? `[${project.name}] ` : "";
}

/** @param {number} ms */
function seconds(ms) {
  return `${Math.round(ms / 1000)}s`;
}
