import { afterEach, describe, expect, it, vi } from "vitest";
import { TTLCache } from "./cache";

describe("TTLCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("get() returns undefined for missing key", () => {
    const cache = new TTLCache<string>();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("set() + get() returns stored value before TTL expires", () => {
    const cache = new TTLCache<string>(60);
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("get() returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string>(1);
    cache.set("key", "value");
    vi.advanceTimersByTime(1001);
    expect(cache.get("key")).toBeUndefined();
  });

  it("per-entry ttl override expires independently of default", () => {
    vi.useFakeTimers();
    const cache = new TTLCache<string>(60);
    cache.set("short", "a", 1);
    cache.set("long", "b", 60);
    vi.advanceTimersByTime(1001);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("b");
  });

  it("clear() removes all entries", () => {
    const cache = new TTLCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("invalidate(key) removes single entry", () => {
    const cache = new TTLCache<string>();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });
});
