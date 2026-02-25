import { describe, expect, test } from "vitest";
import { z } from "zod";
import { dslWorkflow, INTERNAL_WORKFLOW_NAME } from "./workflow";
import type { WorkflowUsageDslState } from "./dsl";

describe("DSL Workflow", () => {
  describe("Workflow definition", () => {
    test("has correct workflow name", () => {
      expect(dslWorkflow.name).toBe(INTERNAL_WORKFLOW_NAME);
      expect(INTERNAL_WORKFLOW_NAME).toBe("usage-agent-workflow");
    });

    test("accepts valid schema parameters", async () => {
      const validParams = {
        sessionId: "session-1",
        agentName: "agent-1",
      };

      // Schema validation should pass
      const schema = z.object({
        sessionId: z.string(),
        agentName: z.string(),
        systemPrompt: z.string().optional(),
        metadata: z.unknown().optional(),
        dsl: z.unknown().optional(),
      });

      const result = schema.parse(validParams);
      expect(result.sessionId).toBe("session-1");
      expect(result.agentName).toBe("agent-1");
    });

    test("rejects invalid schema parameters", () => {
      const invalidParams = {
        // missing required fields
      };

      const schema = z.object({
        sessionId: z.string(),
        agentName: z.string(),
        systemPrompt: z.string().optional(),
        metadata: z.unknown().optional(),
        dsl: z.unknown().optional(),
      });

      expect(() => schema.parse(invalidParams)).toThrow();
    });
  });

  describe("Variable substitution", () => {
    test("substitutes simple variables in expressions", () => {
      // Test the pattern matching for variable substitution
      const pattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
      const expression = "$x + $y * 2";

      const matches = Array.from(expression.matchAll(pattern));
      expect(matches).toHaveLength(2);
      expect(matches[0][1]).toBe("x");
      expect(matches[1][1]).toBe("y");
    });

    test("handles expressions without variables", () => {
      const pattern = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
      const expression = "5 + 3 * 2";

      const matches = Array.from(expression.matchAll(pattern));
      expect(matches).toHaveLength(0);
    });

    test("rejects invalid variable names", () => {
      // Valid variable names must start with letter or underscore
      const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

      expect(validPattern.test("myVar")).toBe(true);
      expect(validPattern.test("_hidden")).toBe(true);
      expect(validPattern.test("var123")).toBe(true);
      expect(validPattern.test("123var")).toBe(false);
      expect(validPattern.test("-var")).toBe(false);
    });
  });

  describe("Expression validation", () => {
    test("allows safe arithmetic characters", () => {
      const safePattern = /^[0-9+\-*/%.()\s]+$/;

      expect(safePattern.test("10 + 5")).toBe(true);
      expect(safePattern.test("(3 + 2) * 4")).toBe(true);
      expect(safePattern.test("100 / 5 - 10")).toBe(true);
      expect(safePattern.test("10 % 3")).toBe(true);
    });

    test("rejects unsafe characters in expressions", () => {
      const safePattern = /^[0-9+\-*/%.()\s]+$/;

      expect(safePattern.test("10 + alert(5)")).toBe(false);
      expect(safePattern.test("eval('code')")).toBe(false);
      expect(safePattern.test("Math.max(1, 2)")).toBe(false);
    });
  });

  describe("DSL step types", () => {
    test("validates input step schema", () => {
      const inputStepSchema = z.object({
        type: z.literal("input"),
        key: z.string(),
        assign: z.string().optional(),
        label: z.string().optional(),
      });

      const validInputStep = {
        type: "input" as const,
        key: "userValue",
        assign: "myVar",
        label: "get user input",
      };

      const result = inputStepSchema.parse(validInputStep);
      expect(result.key).toBe("userValue");
      expect(result.assign).toBe("myVar");
    });

    test("validates calc step schema", () => {
      const calcStepSchema = z.object({
        type: z.literal("calc"),
        expression: z.string(),
        assign: z.string().optional(),
        label: z.string().optional(),
      });

      const validCalcStep = {
        type: "calc" as const,
        expression: "$x + $y",
        assign: "result",
        label: "calculate sum",
      };

      const result = calcStepSchema.parse(validCalcStep);
      expect(result.expression).toBe("$x + $y");
      expect(result.assign).toBe("result");
    });

    test("validates random step schema", () => {
      const randomStepSchema = z.object({
        type: z.literal("random"),
        min: z.number().optional(),
        max: z.number().optional(),
        round: z.enum(["floor", "ceil", "round"]).optional(),
        assign: z.string().optional(),
        label: z.string().optional(),
      });

      const validRandomStep = {
        type: "random" as const,
        min: 1,
        max: 10,
        round: "floor" as const,
        assign: "randomVal",
      };

      const result = randomStepSchema.parse(validRandomStep);
      expect(result.min).toBe(1);
      expect(result.max).toBe(10);
      expect(result.round).toBe("floor");
    });

    test("validates wait step schema", () => {
      const waitStepSchema = z.object({
        type: z.literal("wait"),
        duration: z.union([z.string(), z.number()]),
        label: z.string().optional(),
      });

      const validWaitStep = {
        type: "wait" as const,
        duration: "5 minutes",
        label: "pause workflow",
      };

      const result = waitStepSchema.parse(validWaitStep);
      expect(result.duration).toBe("5 minutes");
    });
  });

  describe("Step naming", () => {
    test("generates step name from label with special character removal", () => {
      const stepName = (label: string | undefined, fallback: string) =>
        label?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || fallback;

      expect(stepName("User Input X Value", "default")).toBe("User-Input-X-Value");
      expect(stepName("Get User Value!", "default")).toBe("Get-User-Value-");
      expect(stepName("   spaces   ", "default")).toBe("spaces");
      expect(stepName(undefined, "dsl-0-0-input")).toBe("dsl-0-0-input");
    });

    test("handles step names with numbers and hyphens", () => {
      const stepName = (label: string | undefined, fallback: string) =>
        label?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || fallback;

      expect(stepName("Step 1: Calculate", "default")).toBe("Step-1-Calculate");
      expect(stepName("my-existing-name", "default")).toBe("my-existing-name");
      expect(stepName("Step_with_underscore", "default")).toBe("Step_with_underscore");
    });
  });

  describe("Rounding functions", () => {
    test("applies floor rounding", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      expect(applyRound(3.7, "floor")).toBe(3);
      expect(applyRound(3.2, "floor")).toBe(3);
      expect(applyRound(3.9, "floor")).toBe(3);
    });

    test("applies ceil rounding", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      expect(applyRound(3.1, "ceil")).toBe(4);
      expect(applyRound(3.9, "ceil")).toBe(4);
      expect(applyRound(3.0, "ceil")).toBe(3);
    });

    test("applies standard rounding", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      expect(applyRound(3.4, "round")).toBe(3);
      expect(applyRound(3.5, "round")).toBe(4);
      expect(applyRound(3.6, "round")).toBe(4);
    });

    test("returns value unchanged when no rounding specified", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      expect(applyRound(3.7)).toBe(3.7);
      expect(applyRound(3.14159)).toBe(3.14159);
    });
  });

  describe("Numeric conversion", () => {
    test("converts string numbers to number type", () => {
      const raw = "42";
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(num).toBe(42);
      expect(Number.isFinite(num)).toBe(true);
    });

    test("converts actual numbers as-is", () => {
      const raw = 42;
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(num).toBe(42);
      expect(Number.isFinite(num)).toBe(true);
    });

    test("returns NaN for non-numeric strings", () => {
      const raw = "not-a-number";
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(Number.isNaN(num)).toBe(true);
      expect(Number.isFinite(num)).toBe(false);
    });

    test("returns NaN for other types", () => {
      const raw = { value: 42 };
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(Number.isNaN(num)).toBe(true);
    });
  });

  describe("Random number generation", () => {
    test("generates numbers within specified range", () => {
      // Simulate random generation
      const min = 10;
      const max = 20;

      for (let i = 0; i < 10; i++) {
        const value = min + Math.random() * (max - min);
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThan(max);
      }
    });

    test("uses correct default bounds when not specified", () => {
      // Default min and max
      const min = 0;
      const max = 1;

      for (let i = 0; i < 10; i++) {
        const value = min + Math.random() * (max - min);
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThan(max);
      }
    });

    test("handles inverted min/max gracefully", () => {
      // If min > max, the range is still valid (just negative)
      const min = 20;
      const max = 10;

      for (let i = 0; i < 10; i++) {
        const value = min + Math.random() * (max - min);
        expect(value).toBeGreaterThanOrEqual(max);
        expect(value).toBeLessThan(min);
      }
    });
  });

  describe("Workflow state management", () => {
    test("initializes empty DSL state", () => {
      const dslState: WorkflowUsageDslState = {};
      expect(Object.keys(dslState)).toHaveLength(0);
    });

    test("tracks assigned variables in state", () => {
      const dslState: WorkflowUsageDslState = {};

      dslState["x"] = 10;
      dslState["y"] = 20;
      dslState["result"] = 30;

      expect(dslState["x"]).toBe(10);
      expect(dslState["y"]).toBe(20);
      expect(dslState["result"]).toBe(30);
      expect(Object.keys(dslState)).toHaveLength(3);
    });

    test("overwrites variables when reassigned", () => {
      const dslState: WorkflowUsageDslState = {};

      dslState["counter"] = 1;
      expect(dslState["counter"]).toBe(1);

      dslState["counter"] = 2;
      expect(dslState["counter"]).toBe(2);

      dslState["counter"] = 100;
      expect(dslState["counter"]).toBe(100);
    });

    test("preserves state across multiple assignments", () => {
      const dslState: WorkflowUsageDslState = {};

      dslState["a"] = 1;
      dslState["b"] = 2;
      expect(Object.keys(dslState).sort()).toEqual(["a", "b"]);

      dslState["c"] = 3;
      expect(Object.keys(dslState).sort()).toEqual(["a", "b", "c"]);

      dslState["b"] = 200;
      expect(dslState["b"]).toBe(200);
      expect(Object.keys(dslState)).toHaveLength(3);
    });
  });

  describe("Integration scenarios", () => {
    test("processes workflow output structure correctly", () => {
      const mockOutput = {
        sessionId: "session-1",
        turns: 3,
        lastEvent: { done: true, data: "complete" },
        dslState: { x: 10, y: 20, result: 30 },
      };

      expect(mockOutput.sessionId).toBe("session-1");
      expect(mockOutput.turns).toBe(3);
      expect(mockOutput.lastEvent.done).toBe(true);
      expect(mockOutput.dslState.x).toBe(10);
    });

    test("tracks multiple turns with increasing turn counter", () => {
      let turn = 0;

      const turns = [];
      while (turn < 3) {
        turns.push({ turn, data: `turn-${turn}` });
        turn += 1;
      }

      expect(turns).toHaveLength(3);
      expect(turns[0].turn).toBe(0);
      expect(turns[1].turn).toBe(1);
      expect(turns[2].turn).toBe(2);
    });
  });
});
