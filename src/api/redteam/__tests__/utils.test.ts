import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedTeamRunOptions } from "../models";
import {
  buildCreateRunBody,
  getGenerationPollIntervalMs,
  getGenerationTimeoutMs,
  getRedTeamTimeoutMs,
  mapResultsPage,
  mapRiskScore,
  unwrapEnvelope,
  validateRedTeamInputs,
} from "../utils";

const noop = async () => "ok";

describe("validateRedTeamInputs", () => {
  it("rejects a non-function task", () => {
    const options = { configId: "cfg-1", task: "not-a-fn" } as unknown as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("accepts a plain arrow function task", () => {
    const options = { configId: "cfg-1", task: noop } as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBe(true);
  });

  it("rejects a missing configId", () => {
    const options = { task: noop } as unknown as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("rejects an empty-string configId", () => {
    const options = { configId: "", task: noop } as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("accepts a valid options object", () => {
    const options: RedTeamRunOptions = { configId: "cfg-1", task: noop };
    expect(validateRedTeamInputs(options)).toBe(true);
  });

  it("rejects maxConcurrency: 0 (would silently produce zero pollers)", () => {
    const options = { configId: "cfg-1", task: noop, maxConcurrency: 0 } as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("rejects a negative maxConcurrency", () => {
    const options = { configId: "cfg-1", task: noop, maxConcurrency: -1 } as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("rejects a non-integer maxConcurrency", () => {
    const options = { configId: "cfg-1", task: noop, maxConcurrency: 2.5 } as RedTeamRunOptions;
    expect(validateRedTeamInputs(options)).toBeNull();
  });

  it("accepts a valid positive integer maxConcurrency", () => {
    const options: RedTeamRunOptions = { configId: "cfg-1", task: noop, maxConcurrency: 3 };
    expect(validateRedTeamInputs(options)).toBe(true);
  });

  it("accepts an unset maxConcurrency (defaults elsewhere)", () => {
    const options: RedTeamRunOptions = { configId: "cfg-1", task: noop };
    expect(validateRedTeamInputs(options)).toBe(true);
  });
});

describe("buildCreateRunBody", () => {
  it("emits only {configId}", () => {
    const options: RedTeamRunOptions = { configId: "cfg-123", task: noop };
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

  it("getRedTeamTimeoutMs: unset -> default (20s -> 20000ms)", () => {
    expect(getRedTeamTimeoutMs()).toBe(20000);
  });

  it("getRedTeamTimeoutMs: valid value is honored (seconds -> ms)", () => {
    process.env.NETRA_REDTEAM_TIMEOUT = "10";
    expect(getRedTeamTimeoutMs()).toBe(10000);
  });

  it("getRedTeamTimeoutMs: NaN -> default + warn", () => {
    process.env.NETRA_REDTEAM_TIMEOUT = "not-a-number";
    expect(getRedTeamTimeoutMs()).toBe(20000);
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
