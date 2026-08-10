import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedteamRunOptions } from "../models";
import {
  buildCreateRunBody,
  getGenerationPollIntervalMs,
  getGenerationTimeoutMs,
  getRedteamTimeoutMs,
  mapResultsPage,
  mapRiskScore,
  unwrapEnvelope,
  validateRedteamInputs,
} from "../utils";

const noop = async () => "ok";

describe("validateRedteamInputs", () => {
  it("rejects a non-function handler", () => {
    const options = { configId: "cfg-1", handler: "not-a-fn" } as unknown as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("accepts a plain arrow function handler", () => {
    const options = { configId: "cfg-1", handler: noop } as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBe(true);
  });

  it("rejects a missing configId", () => {
    const options = { handler: noop } as unknown as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("rejects an empty-string configId", () => {
    const options = { configId: "", handler: noop } as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("accepts a valid options object", () => {
    const options: RedteamRunOptions = { configId: "cfg-1", handler: noop };
    expect(validateRedteamInputs(options)).toBe(true);
  });

  it("rejects maxConcurrency: 0 (would silently produce zero pollers)", () => {
    const options = { configId: "cfg-1", handler: noop, maxConcurrency: 0 } as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("rejects a negative maxConcurrency", () => {
    const options = { configId: "cfg-1", handler: noop, maxConcurrency: -1 } as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("rejects a non-integer maxConcurrency", () => {
    const options = { configId: "cfg-1", handler: noop, maxConcurrency: 2.5 } as RedteamRunOptions;
    expect(validateRedteamInputs(options)).toBeNull();
  });

  it("accepts a valid positive integer maxConcurrency", () => {
    const options: RedteamRunOptions = { configId: "cfg-1", handler: noop, maxConcurrency: 3 };
    expect(validateRedteamInputs(options)).toBe(true);
  });

  it("accepts an unset maxConcurrency (defaults elsewhere)", () => {
    const options: RedteamRunOptions = { configId: "cfg-1", handler: noop };
    expect(validateRedteamInputs(options)).toBe(true);
  });
});

describe("buildCreateRunBody", () => {
  it("emits only {configId}", () => {
    const options: RedteamRunOptions = { configId: "cfg-123", handler: noop };
    expect(buildCreateRunBody(options)).toEqual({ configId: "cfg-123" });
  });
});

describe("env parsing", () => {
  const ENV_VARS = [
    "NETRA_REDTEAM_TIMEOUT",
    "NETRA_REDTEAM_GENERATION_POLL_INTERVAL",
    "NETRA_REDTEAM_GENERATION_TIMEOUT",
  ];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_VARS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    vi.restoreAllMocks();
  });

  it("getRedteamTimeoutMs: unset -> default (20s -> 20000ms)", () => {
    expect(getRedteamTimeoutMs()).toBe(20000);
  });

  it("getRedteamTimeoutMs: valid value is honored (seconds -> ms)", () => {
    process.env.NETRA_REDTEAM_TIMEOUT = "10";
    expect(getRedteamTimeoutMs()).toBe(10000);
  });

  it("getRedteamTimeoutMs: NaN -> default + warn", () => {
    process.env.NETRA_REDTEAM_TIMEOUT = "not-a-number";
    expect(getRedteamTimeoutMs()).toBe(20000);
  });

  it("getGenerationPollIntervalMs: unset -> default (2s -> 2000ms)", () => {
    expect(getGenerationPollIntervalMs()).toBe(2000);
  });

  it("getGenerationTimeoutMs: unset -> default (300s -> 300000ms)", () => {
    expect(getGenerationTimeoutMs()).toBe(300000);
  });
});

describe("unwrapEnvelope", () => {
  it("unwraps a single {data} envelope", () => {
    expect(unwrapEnvelope({ success: true, data: { foo: "bar" } })).toEqual({ foo: "bar" });
  });

  it("does not additionally unwrap a payload whose own field happens to be named data (e.g. a results page)", () => {
    expect(unwrapEnvelope({ success: true, data: { data: [{ foo: "bar" }], total: 1 } })).toEqual({
      data: [{ foo: "bar" }],
      total: 1,
    });
  });
});

describe("response mappers", () => {
  it("maps a results page", () => {
    const page = mapResultsPage({
      data: [{ evaluatorId: "ev-1", status: "pass", score: 0.9 }],
      page: 1,
      limit: 200,
      total: 1,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ evaluatorId: "ev-1", status: "pass", score: 0.9 });
  });

  it("maps an empty results page", () => {
    const page = mapResultsPage({ data: [], page: 1, limit: 200, total: 0 });
    expect(page.items).toEqual([]);
  });

  it("maps a risk score payload through unchanged", () => {
    expect(mapRiskScore({ latestSafetyScore: 82 })).toEqual({ latestSafetyScore: 82 });
  });
});
