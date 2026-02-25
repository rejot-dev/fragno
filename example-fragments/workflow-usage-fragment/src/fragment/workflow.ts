import { defineWorkflow } from "@fragno-dev/workflows";
import { z } from "zod";

import type { WorkflowUsageDslState } from "./dsl";
import { workflowUsageHooks } from "./definition";
import { workflowUsageSchema } from "./schema";

export const INTERNAL_WORKFLOW_NAME = "usage-agent-workflow";

const dslStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wait"),
    duration: z.union([z.string(), z.number()]),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("calc"),
    expression: z.string(),
    assign: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("random"),
    min: z.number().optional(),
    max: z.number().optional(),
    round: z.enum(["floor", "ceil", "round"]).optional(),
    assign: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("input"),
    key: z.string(),
    assign: z.string().optional(),
    label: z.string().optional(),
  }),
]);

const dslSchema = z.object({
  steps: z.array(dslStepSchema),
});

const agentParamsSchema = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  systemPrompt: z.string().optional(),
  metadata: z.unknown().optional(),
  dsl: dslSchema.optional(),
});

const stepName = (label: string | undefined, fallback: string) =>
  label?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || fallback;

const VAR_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

function substituteVariables(expression: string, state: WorkflowUsageDslState): string {
  return expression.replace(VAR_PATTERN, (_, name) => {
    if (!(name in state)) {
      throw new Error(`Unknown variable $${name} in expression.`);
    }
    const value = state[name];
    return String(value);
  });
}

const evaluateExpression = (expression: string, state: WorkflowUsageDslState): number => {
  const substituted = substituteVariables(expression, state);
  if (!/^[0-9+\-*/%.()\s]+$/.test(substituted)) {
    throw new Error(
      "DSL calc expression contains unsupported characters after variable substitution.",
    );
  }
  return Function(`"use strict"; return (${substituted});`)() as number;
};

const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
  if (!round) {
    return value;
  }
  return Math[round](value);
};

function resolveInput(
  payloadObj: Record<string, unknown>,
  key: string,
): { valid: true; value: number } | { valid: false } {
  const raw = payloadObj[key];
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(num) ? { valid: true, value: num } : { valid: false };
}

function generateRandom(min?: number, max?: number, round?: "floor" | "ceil" | "round") {
  const lo = min ?? 0;
  const hi = max ?? 1;
  return { lo, hi, value: applyRound(lo + Math.random() * (hi - lo), round) };
}

export const dslWorkflow = defineWorkflow(
  { name: INTERNAL_WORKFLOW_NAME, schema: agentParamsSchema },
  async (event, step) => {
    const params = agentParamsSchema.parse(event.payload ?? {});
    const dsl = params.dsl;
    const dslState: WorkflowUsageDslState = {};

    await step.do("init", () => ({
      sessionId: params.sessionId,
      agentName: params.agentName,
    }));

    let turn = 0;
    while (true) {
      const message = await step.waitForEvent(`wait-user-${turn}`, {
        type: "user_message",
        timeout: "7 days",
      });

      const payload = message.payload;
      const payloadObj =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

      if (dsl) {
        for (let i = 0; i < dsl.steps.length; i += 1) {
          const entry = dsl.steps[i];
          const name = stepName(entry.label, `dsl-${turn}-${i}-${entry.type}`);

          if (entry.type === "wait") {
            await step.sleep(name, entry.duration);
          } else if (entry.type === "input") {
            const input = resolveInput(payloadObj, entry.key);
            if (!input.valid) {
              await step.do(name, (tx) => {
                const stepResult = { key: entry.key, value: null, skipped: true };
                tx.mutate((ctx) => {
                  ctx.forSchema(workflowUsageSchema).create("step", {
                    sessionId: params.sessionId,
                    turn,
                    index: i,
                    type: entry.type,
                    name,
                    result: stepResult,
                  });
                });
                return stepResult;
              });
              continue;
            }
            const result = await step.do(name, (tx) => {
              const stepResult = { key: entry.key, value: input.value };
              tx.mutate((ctx) => {
                ctx.forSchema(workflowUsageSchema).create("step", {
                  sessionId: params.sessionId,
                  turn,
                  index: i,
                  type: entry.type,
                  name,
                  result: stepResult,
                });
              });
              return stepResult;
            });
            dslState[entry.assign ?? entry.key] = result.value;
          } else if (entry.type === "calc") {
            const computed = evaluateExpression(entry.expression, dslState);
            const result = await step.do(name, (tx) => {
              const stepResult = { expression: entry.expression, result: computed };
              tx.mutate((ctx) => {
                ctx.forSchema(workflowUsageSchema).create("step", {
                  sessionId: params.sessionId,
                  turn,
                  index: i,
                  type: entry.type,
                  name,
                  result: stepResult,
                });
              });
              return stepResult;
            });
            if (entry.assign) {
              dslState[entry.assign] = result.result;
            }
          } else {
            const { lo, hi, value } = generateRandom(entry.min, entry.max, entry.round);
            const result = await step.do(name, (tx) => {
              const stepResult = { min: lo, max: hi, value, round: entry.round };
              tx.mutate((ctx) => {
                ctx.forSchema(workflowUsageSchema).create("step", {
                  sessionId: params.sessionId,
                  turn,
                  index: i,
                  type: entry.type,
                  name,
                  result: stepResult,
                });
              });
              return stepResult;
            });
            if (entry.assign) {
              dslState[entry.assign] = result.value;
            }
          }
        }
      }

      await step.do(`event-${turn}`, (tx) => {
        const stepResult = { payload };
        tx.mutate((ctx) => {
          ctx.forSchema(workflowUsageSchema).create("step", {
            sessionId: params.sessionId,
            turn,
            index: dsl ? dsl.steps.length : 0,
            type: "event",
            name: `event-${turn}`,
            result: stepResult,
          });
        });
        return stepResult;
      });

      if (
        payload &&
        typeof payload === "object" &&
        "done" in payload &&
        (payload as Record<string, unknown>)["done"]
      ) {
        const completedTurns = turn + 1;

        await step.do("session-completed", (tx) => {
          tx.mutate((ctx) => {
            ctx
              .forSchema(workflowUsageSchema, workflowUsageHooks)
              .triggerHook("onSessionCompleted", {
                sessionId: params.sessionId,
                agentName: params.agentName,
                turns: completedTurns,
                dslState: { ...dslState },
              });
          });
        });

        return {
          sessionId: params.sessionId,
          turns: completedTurns,
          lastEvent: payload,
          dslState,
        };
      }

      turn += 1;
    }
  },
);
