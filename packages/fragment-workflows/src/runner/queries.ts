// Transaction wrapper for executing handler-scoped database work.

import type { DatabaseRequestContext } from "@fragno-dev/db";
import type { RunHandlerTx, WorkflowsRunnerFragment } from "./types";

export const runHandlerTx = async <T>(
  fragment: WorkflowsRunnerFragment,
  callback: (handlerTx: DatabaseRequestContext["handlerTx"]) => T | Promise<T>,
): Promise<T> => {
  return await fragment.inContext(function (this: DatabaseRequestContext) {
    const handlerTx: DatabaseRequestContext["handlerTx"] = (options) => this.handlerTx(options);
    return callback(handlerTx);
  });
};

export type { RunHandlerTx } from "./types";
