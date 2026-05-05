import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "vite-plus/test";

expect.extend(matchers);

// Mock ResizeObserver for Radix UI components that use it (like Slider)
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
