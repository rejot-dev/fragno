import { describe, it, expect } from "vitest";
import {
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
  NoRetryPolicy,
} from "./retry-policy";

describe("ExponentialBackoffRetryPolicy", () => {
  describe("default options", () => {
    it("should use default maxRetries of 3", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      expect(policy.shouldRetry(0)).toBe(true);
      expect(policy.shouldRetry(1)).toBe(true);
      expect(policy.shouldRetry(2)).toBe(true);
      expect(policy.shouldRetry(3)).toBe(false);
    });

    it("should use default initialDelayMs of 100", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      expect(policy.getDelayMs(0)).toBe(100);
    });

    it("should use default backoffMultiplier of 2", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      expect(policy.getDelayMs(0)).toBe(100);
      expect(policy.getDelayMs(1)).toBe(200);
      expect(policy.getDelayMs(2)).toBe(400);
    });

    it("should cap at maxDelayMs of 10000", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      expect(policy.getDelayMs(10)).toBe(10000);
    });
  });

  describe("custom options", () => {
    it("should respect custom maxRetries", () => {
      const policy = new ExponentialBackoffRetryPolicy({ maxRetries: 5 });

      expect(policy.shouldRetry(4)).toBe(true);
      expect(policy.shouldRetry(5)).toBe(false);
    });

    it("should respect custom initialDelayMs", () => {
      const policy = new ExponentialBackoffRetryPolicy({ initialDelayMs: 50 });

      expect(policy.getDelayMs(0)).toBe(50);
      expect(policy.getDelayMs(1)).toBe(100);
    });

    it("should respect custom maxDelayMs", () => {
      const policy = new ExponentialBackoffRetryPolicy({ maxDelayMs: 500 });

      expect(policy.getDelayMs(10)).toBe(500);
    });

    it("should respect custom backoffMultiplier", () => {
      const policy = new ExponentialBackoffRetryPolicy({
        initialDelayMs: 100,
        backoffMultiplier: 3,
      });

      expect(policy.getDelayMs(0)).toBe(100);
      expect(policy.getDelayMs(1)).toBe(300);
      expect(policy.getDelayMs(2)).toBe(900);
    });
  });

  describe("AbortSignal handling", () => {
    it("should return false if signal is aborted", () => {
      const policy = new ExponentialBackoffRetryPolicy();
      const controller = new AbortController();
      controller.abort();

      expect(policy.shouldRetry(0, undefined, controller.signal)).toBe(false);
    });

    it("should return true if signal is not aborted", () => {
      const policy = new ExponentialBackoffRetryPolicy();
      const controller = new AbortController();

      expect(policy.shouldRetry(0, undefined, controller.signal)).toBe(true);
    });
  });

  describe("exponential delay calculation", () => {
    it("should calculate correct exponential delays", () => {
      const policy = new ExponentialBackoffRetryPolicy({
        initialDelayMs: 10,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
      });

      expect(policy.getDelayMs(0)).toBe(10);
      expect(policy.getDelayMs(1)).toBe(20);
      expect(policy.getDelayMs(2)).toBe(40);
      expect(policy.getDelayMs(3)).toBe(80);
      expect(policy.getDelayMs(4)).toBe(160);
      expect(policy.getDelayMs(5)).toBe(320);
      expect(policy.getDelayMs(6)).toBe(640);
      expect(policy.getDelayMs(7)).toBe(1000); // capped at maxDelayMs
    });
  });
});

describe("LinearBackoffRetryPolicy", () => {
  describe("default options", () => {
    it("should use default maxRetries of 3", () => {
      const policy = new LinearBackoffRetryPolicy();

      expect(policy.shouldRetry(0)).toBe(true);
      expect(policy.shouldRetry(1)).toBe(true);
      expect(policy.shouldRetry(2)).toBe(true);
      expect(policy.shouldRetry(3)).toBe(false);
    });

    it("should use default delayMs of 100", () => {
      const policy = new LinearBackoffRetryPolicy();

      expect(policy.getDelayMs(0)).toBe(100);
    });

    it("should use default incrementMs of 100", () => {
      const policy = new LinearBackoffRetryPolicy();

      expect(policy.getDelayMs(0)).toBe(100);
      expect(policy.getDelayMs(1)).toBe(200);
      expect(policy.getDelayMs(2)).toBe(300);
    });
  });

  describe("custom options", () => {
    it("should respect custom maxRetries", () => {
      const policy = new LinearBackoffRetryPolicy({ maxRetries: 5 });

      expect(policy.shouldRetry(4)).toBe(true);
      expect(policy.shouldRetry(5)).toBe(false);
    });

    it("should respect custom delayMs", () => {
      const policy = new LinearBackoffRetryPolicy({ delayMs: 50 });

      expect(policy.getDelayMs(0)).toBe(50);
      expect(policy.getDelayMs(1)).toBe(150);
    });

    it("should respect custom incrementMs", () => {
      const policy = new LinearBackoffRetryPolicy({ incrementMs: 50 });

      expect(policy.getDelayMs(0)).toBe(100);
      expect(policy.getDelayMs(1)).toBe(150);
      expect(policy.getDelayMs(2)).toBe(200);
    });
  });

  describe("AbortSignal handling", () => {
    it("should return false if signal is aborted", () => {
      const policy = new LinearBackoffRetryPolicy();
      const controller = new AbortController();
      controller.abort();

      expect(policy.shouldRetry(0, undefined, controller.signal)).toBe(false);
    });

    it("should return true if signal is not aborted", () => {
      const policy = new LinearBackoffRetryPolicy();
      const controller = new AbortController();

      expect(policy.shouldRetry(0, undefined, controller.signal)).toBe(true);
    });
  });

  describe("linear delay calculation", () => {
    it("should calculate correct linear delays", () => {
      const policy = new LinearBackoffRetryPolicy({
        delayMs: 10,
        incrementMs: 5,
      });

      expect(policy.getDelayMs(0)).toBe(10);
      expect(policy.getDelayMs(1)).toBe(15);
      expect(policy.getDelayMs(2)).toBe(20);
      expect(policy.getDelayMs(3)).toBe(25);
      expect(policy.getDelayMs(4)).toBe(30);
    });
  });
});

describe("NoRetryPolicy", () => {
  it("should always return false for shouldRetry", () => {
    const policy = new NoRetryPolicy();

    expect(policy.shouldRetry(0)).toBe(false);
    expect(policy.shouldRetry(1)).toBe(false);
    expect(policy.shouldRetry(100)).toBe(false);
  });

  it("should always return 0 for getDelayMs", () => {
    const policy = new NoRetryPolicy();

    expect(policy.getDelayMs(0)).toBe(0);
    expect(policy.getDelayMs(1)).toBe(0);
    expect(policy.getDelayMs(100)).toBe(0);
  });

  it("should ignore abort signal", () => {
    const policy = new NoRetryPolicy();
    const controller = new AbortController();
    controller.abort();

    expect(policy.shouldRetry(0, undefined, controller.signal)).toBe(false);
  });
});
