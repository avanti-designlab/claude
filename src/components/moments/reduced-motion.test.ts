import { describe, expect, test, vi } from "vitest";
import {
  reducedMotionSnapshot,
  resolveReducedMotion,
  subscribeToMediaQuery,
  type MediaQueryLike,
} from "./reduced-motion";

describe("reducedMotionSnapshot", () => {
  test("mirrors the media query state", () => {
    expect(reducedMotionSnapshot({ matches: true })).toBe(true);
    expect(reducedMotionSnapshot({ matches: false })).toBe(false);
  });

  test("no matchMedia (SSR) defaults to REDUCED — final state, never hidden content", () => {
    expect(reducedMotionSnapshot(null)).toBe(true);
    expect(reducedMotionSnapshot(undefined)).toBe(true);
  });
});

describe("resolveReducedMotion", () => {
  test("explicit override wins over the system preference", () => {
    expect(resolveReducedMotion(true, false)).toBe(true);
    expect(resolveReducedMotion(false, true)).toBe(false);
  });

  test("no override follows the system preference", () => {
    expect(resolveReducedMotion(null, true)).toBe(true);
    expect(resolveReducedMotion(null, false)).toBe(false);
  });
});

describe("subscribeToMediaQuery", () => {
  test("uses the modern listener API and unsubscribes cleanly", () => {
    const listeners = new Set<() => void>();
    const mql: MediaQueryLike = {
      matches: false,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const onChange = vi.fn();
    const unsubscribe = subscribeToMediaQuery(mql, onChange);
    expect(listeners.size).toBe(1);

    for (const notify of listeners) notify();
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  test("falls back to the legacy addListener API (older Safari)", () => {
    const listeners = new Set<() => void>();
    const mql: MediaQueryLike = {
      matches: true,
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    };
    const onChange = vi.fn();
    const unsubscribe = subscribeToMediaQuery(mql, onChange);
    expect(listeners.size).toBe(1);

    for (const notify of listeners) notify();
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  test("no media query object is a no-op unsubscribe", () => {
    expect(() => subscribeToMediaQuery(null, vi.fn())()).not.toThrow();
  });
});
