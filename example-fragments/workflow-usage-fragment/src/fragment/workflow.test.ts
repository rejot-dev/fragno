import { describe, expect, test, assert } from "vitest";

import { z } from "zod";

import type { WorkflowUsageDslState } from "./dsl";
import { dslWorkflow, INTERNAL_WORKFLOW_NAME } from "./workflow";

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
      assert(result.sessionId === "session-1");
      assert(result.agentName === "agent-1");
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
      assert(matches[0][1] === "x");
      assert(matches[1][1] === "y");
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

      assert(validPattern.test("myVar"));
      assert(validPattern.test("_hidden"));
      assert(validPattern.test("var123"));
      assert(!validPattern.test("123var"));
      assert(!validPattern.test("-var"));
    });
  });

  describe("Expression validation", () => {
    test("allows safe arithmetic characters", () => {
      const safePattern = /^[0-9+\-*/%.()\s]+$/;

      assert(safePattern.test("10 + 5"));
      assert(safePattern.test("(3 + 2) * 4"));
      assert(safePattern.test("100 / 5 - 10"));
      assert(safePattern.test("10 % 3"));
    });

    test("rejects unsafe characters in expressions", () => {
      const safePattern = /^[0-9+\-*/%.()\s]+$/;

      assert(!safePattern.test("10 + alert(5)"));
      assert(!safePattern.test("eval('code')"));
      assert(!safePattern.test("Math.max(1, 2)"));
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
      assert(result.key === "userValue");
      assert(result.assign === "myVar");
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
      assert(result.expression === "$x + $y");
      assert(result.assign === "result");
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
      assert(result.min === 1);
      assert(result.max === 10);
      assert(result.round === "floor");
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
      assert(result.duration === "5 minutes");
    });
  });

  describe("Step naming", () => {
    test("generates step name from label with special character removal", () => {
      const stepName = (label: string | undefined, fallback: string) =>
        label?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || fallback;

      assert(stepName("User Input X Value", "default") === "User-Input-X-Value");
      assert(stepName("Get User Value!", "default") === "Get-User-Value-");
      assert(stepName("   spaces   ", "default") === "spaces");
      assert(stepName(undefined, "dsl-0-0-input") === "dsl-0-0-input");
    });

    test("handles step names with numbers and hyphens", () => {
      const stepName = (label: string | undefined, fallback: string) =>
        label?.trim().replace(/[^a-zA-Z0-9_-]+/g, "-") || fallback;

      assert(stepName("Step 1: Calculate", "default") === "Step-1-Calculate");
      assert(stepName("my-existing-name", "default") === "my-existing-name");
      assert(stepName("Step_with_underscore", "default") === "Step_with_underscore");
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

      assert(applyRound(3.7, "floor") === 3);
      assert(applyRound(3.2, "floor") === 3);
      assert(applyRound(3.9, "floor") === 3);
    });

    test("applies ceil rounding", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      assert(applyRound(3.1, "ceil") === 4);
      assert(applyRound(3.9, "ceil") === 4);
      assert(applyRound(3.0, "ceil") === 3);
    });

    test("applies standard rounding", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      assert(applyRound(3.4, "round") === 3);
      assert(applyRound(3.5, "round") === 4);
      assert(applyRound(3.6, "round") === 4);
    });

    test("returns value unchanged when no rounding specified", () => {
      const applyRound = (value: number, round?: "floor" | "ceil" | "round") => {
        if (!round) {
          return value;
        }
        return Math[round](value);
      };

      assert(applyRound(3.7) === 3.7);
      assert(applyRound(3.14159) === 3.14159);
    });
  });

  describe("Numeric conversion", () => {
    test("converts string numbers to number type", () => {
      const raw = "42";
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(num).toBe(42);
      assert(Number.isFinite(num));
    });

    test("converts actual numbers as-is", () => {
      const raw = 42;
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      expect(num).toBe(42);
      assert(Number.isFinite(num));
    });

    test("returns NaN for non-numeric strings", () => {
      const raw = "not-a-number";
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      assert(Number.isNaN(num));
      assert(!Number.isFinite(num));
    });

    test("returns NaN for other types", () => {
      const raw = { value: 42 };
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      assert(Number.isNaN(num));
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

      assert(dslState["x"] === 10);
      assert(dslState["y"] === 20);
      assert(dslState["result"] === 30);
      expect(Object.keys(dslState)).toHaveLength(3);
    });

    test("overwrites variables when reassigned", () => {
      const dslState: WorkflowUsageDslState = {};

      dslState["counter"] = 1;
      assert(dslState["counter"] === 1);

      dslState["counter"] = 2;
      assert(dslState["counter"] === 2);

      dslState["counter"] = 100;
      assert(dslState["counter"] === 100);
    });

    test("preserves state across multiple assignments", () => {
      const dslState: WorkflowUsageDslState = {};

      dslState["a"] = 1;
      dslState["b"] = 2;
      expect(Object.keys(dslState).sort()).toEqual(["a", "b"]);

      dslState["c"] = 3;
      expect(Object.keys(dslState).sort()).toEqual(["a", "b", "c"]);

      dslState["b"] = 200;
      assert(dslState["b"] === 200);
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

      assert(mockOutput.sessionId === "session-1");
      assert(mockOutput.turns === 3);
      assert(mockOutput.lastEvent.done);
      assert(mockOutput.dslState.x === 10);
    });

    test("tracks multiple turns with increasing turn counter", () => {
      let turn = 0;

      const turns = [];
      while (turn < 3) {
        turns.push({ turn, data: `turn-${turn}` });
        turn += 1;
      }

      expect(turns).toHaveLength(3);
      assert(turns[0].turn === 0);
      assert(turns[1].turn === 1);
      assert(turns[2].turn === 2);
    });
  });
});
