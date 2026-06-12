import { describe, it, assert } from "vitest";

import {
  ExponentialBackoffRetryPolicy,
  LinearBackoffRetryPolicy,
  NoRetryPolicy,
} from "./retry-policy";

describe("ExponentialBackoffRetryPolicy", () => {
  describe("default options", () => {
    it("should use default maxRetries of 3", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      assert(policy.shouldRetry(0));
      assert(policy.shouldRetry(1));
      assert(policy.shouldRetry(2));
      assert(!policy.shouldRetry(3));
    });

    it("should use default initialDelayMs of 100", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      assert(policy.getDelayMs(0) === 100);
    });

    it("should use default backoffMultiplier of 2", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      assert(policy.getDelayMs(0) === 100);
      assert(policy.getDelayMs(1) === 200);
      assert(policy.getDelayMs(2) === 400);
    });

    it("should cap at maxDelayMs of 10000", () => {
      const policy = new ExponentialBackoffRetryPolicy();

      assert(policy.getDelayMs(10) === 10000);
    });
  });

  describe("custom options", () => {
    it("should respect custom maxRetries", () => {
      const policy = new ExponentialBackoffRetryPolicy({ maxRetries: 5 });

      assert(policy.shouldRetry(4));
      assert(!policy.shouldRetry(5));
    });

    it("should respect custom initialDelayMs", () => {
      const policy = new ExponentialBackoffRetryPolicy({ initialDelayMs: 50 });

      assert(policy.getDelayMs(0) === 50);
      assert(policy.getDelayMs(1) === 100);
    });

    it("should respect custom maxDelayMs", () => {
      const policy = new ExponentialBackoffRetryPolicy({ maxDelayMs: 500 });

      assert(policy.getDelayMs(10) === 500);
    });

    it("should respect custom backoffMultiplier", () => {
      const policy = new ExponentialBackoffRetryPolicy({
        initialDelayMs: 100,
        backoffMultiplier: 3,
      });

      assert(policy.getDelayMs(0) === 100);
      assert(policy.getDelayMs(1) === 300);
      assert(policy.getDelayMs(2) === 900);
    });
  });

  describe("AbortSignal handling", () => {
    it("should return false if signal is aborted", () => {
      const policy = new ExponentialBackoffRetryPolicy();
      const controller = new AbortController();
      controller.abort();

      assert(!policy.shouldRetry(0, undefined, controller.signal));
    });

    it("should return true if signal is not aborted", () => {
      const policy = new ExponentialBackoffRetryPolicy();
      const controller = new AbortController();

      assert(policy.shouldRetry(0, undefined, controller.signal));
    });
  });

  describe("exponential delay calculation", () => {
    it("should calculate correct exponential delays", () => {
      const policy = new ExponentialBackoffRetryPolicy({
        initialDelayMs: 10,
        backoffMultiplier: 2,
        maxDelayMs: 1000,
      });

      assert(policy.getDelayMs(0) === 10);
      assert(policy.getDelayMs(1) === 20);
      assert(policy.getDelayMs(2) === 40);
      assert(policy.getDelayMs(3) === 80);
      assert(policy.getDelayMs(4) === 160);
      assert(policy.getDelayMs(5) === 320);
      assert(policy.getDelayMs(6) === 640);
      assert(policy.getDelayMs(7) === 1000); // capped at maxDelayMs
    });
  });
});

describe("LinearBackoffRetryPolicy", () => {
  describe("default options", () => {
    it("should use default maxRetries of 3", () => {
      const policy = new LinearBackoffRetryPolicy();

      assert(policy.shouldRetry(0));
      assert(policy.shouldRetry(1));
      assert(policy.shouldRetry(2));
      assert(!policy.shouldRetry(3));
    });

    it("should use default delayMs of 100", () => {
      const policy = new LinearBackoffRetryPolicy();

      assert(policy.getDelayMs(0) === 100);
    });

    it("should use default incrementMs of 100", () => {
      const policy = new LinearBackoffRetryPolicy();

      assert(policy.getDelayMs(0) === 100);
      assert(policy.getDelayMs(1) === 200);
      assert(policy.getDelayMs(2) === 300);
    });
  });

  describe("custom options", () => {
    it("should respect custom maxRetries", () => {
      const policy = new LinearBackoffRetryPolicy({ maxRetries: 5 });

      assert(policy.shouldRetry(4));
      assert(!policy.shouldRetry(5));
    });

    it("should respect custom delayMs", () => {
      const policy = new LinearBackoffRetryPolicy({ delayMs: 50 });

      assert(policy.getDelayMs(0) === 50);
      assert(policy.getDelayMs(1) === 150);
    });

    it("should respect custom incrementMs", () => {
      const policy = new LinearBackoffRetryPolicy({ incrementMs: 50 });

      assert(policy.getDelayMs(0) === 100);
      assert(policy.getDelayMs(1) === 150);
      assert(policy.getDelayMs(2) === 200);
    });
  });

  describe("AbortSignal handling", () => {
    it("should return false if signal is aborted", () => {
      const policy = new LinearBackoffRetryPolicy();
      const controller = new AbortController();
      controller.abort();

      assert(!policy.shouldRetry(0, undefined, controller.signal));
    });

    it("should return true if signal is not aborted", () => {
      const policy = new LinearBackoffRetryPolicy();
      const controller = new AbortController();

      assert(policy.shouldRetry(0, undefined, controller.signal));
    });
  });

  describe("linear delay calculation", () => {
    it("should calculate correct linear delays", () => {
      const policy = new LinearBackoffRetryPolicy({
        delayMs: 10,
        incrementMs: 5,
      });

      assert(policy.getDelayMs(0) === 10);
      assert(policy.getDelayMs(1) === 15);
      assert(policy.getDelayMs(2) === 20);
      assert(policy.getDelayMs(3) === 25);
      assert(policy.getDelayMs(4) === 30);
    });
  });
});

describe("NoRetryPolicy", () => {
  it("should always return false for shouldRetry", () => {
    const policy = new NoRetryPolicy();

    assert(!policy.shouldRetry(0));
    assert(!policy.shouldRetry(1));
    assert(!policy.shouldRetry(100));
  });

  it("should always return 0 for getDelayMs", () => {
    const policy = new NoRetryPolicy();

    assert(policy.getDelayMs(0) === 0);
    assert(policy.getDelayMs(1) === 0);
    assert(policy.getDelayMs(100) === 0);
  });

  it("should ignore abort signal", () => {
    const policy = new NoRetryPolicy();
    const controller = new AbortController();
    controller.abort();

    assert(!policy.shouldRetry(0, undefined, controller.signal));
  });
});
