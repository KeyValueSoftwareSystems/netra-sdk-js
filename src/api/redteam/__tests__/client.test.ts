import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  context,
  propagation,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstance = {
  get: vi.fn(),
  post: vi.fn(),
  interceptors: {
    request: {
      use: vi.fn(),
    },
  },
};

vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(() => mockInstance),
    },
  };
});

import axios from "axios";
import { Config } from "../../../config";
import {
  RedTeamAuthError,
  RedTeamConfigError,
  RedTeamGenerationError,
  RedTeamGenerationTimeoutError,
  RedTeamRunError,
} from "../models";
import { RedTeamHttpClient } from "../client";

function buildConfig(otlpEndpoint: string): Config {
  process.env.NETRA_OTLP_ENDPOINT = otlpEndpoint;
  process.env.NETRA_API_KEY = "test-api-key";
  return new Config({});
}

describe("RedTeamHttpClient", () => {
  beforeAll(() => {
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      }),
    );
    // A real (not Noop) context manager is required for context.with(...) to
    // actually make the span context "active" for propagation.inject to see.
    context.setGlobalContextManager(new AsyncHooksContextManager().enable());
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NETRA_OTLP_ENDPOINT;
    delete process.env.NETRA_API_KEY;
  });

  afterEach(() => {
    delete process.env.NETRA_OTLP_ENDPOINT;
    delete process.env.NETRA_API_KEY;
  });

  it("strips a trailing /telemetry (and trailing slash) from the base URL", () => {
    const cfg = buildConfig("https://api.getnetra.ai/telemetry/");
    new RedTeamHttpClient(cfg);
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.getnetra.ai" }),
    );
  });

  it("injects the x-api-key header from config.apiKey", () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    new RedTeamHttpClient(cfg);
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "test-api-key" }) }),
    );
  });

  it("registers a request interceptor that injects traceparent headers", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    new RedTeamHttpClient(cfg);

    expect(mockInstance.interceptors.request.use).toHaveBeenCalled();
    const [onFulfilled] = mockInstance.interceptors.request.use.mock.calls[0];

    const spanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    };
    const ctx = trace.setSpanContext(context.active(), spanContext);

    const fakeRequestConfig = { headers: {} as Record<string, string> };
    const result = await context.with(ctx, () => onFulfilled(fakeRequestConfig));

    expect(result.headers.traceparent).toBeDefined();
    expect(result.headers.traceparent).toContain(spanContext.traceId);
  });

  it("unwraps a single {data} envelope on createRun", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    const client = new RedTeamHttpClient(cfg);
    mockInstance.post.mockResolvedValueOnce({
      data: { success: true, data: { runId: "run-1", configId: "cfg-1", status: "running" } },
    });
    const result = await client.createRun({ configId: "cfg-1" });
    expect(result).toEqual({ runId: "run-1", configId: "cfg-1", status: "running" });
  });

  describe("getPrompts", () => {
    it("fetches the run's whole prompt list in one call", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      mockInstance.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            runId: "run-1",
            status: "running",
            turnType: "single",
            multiTurnCount: 5,
            prompts: [{ id: "p1", prompt: "attack", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
          },
        },
      });

      const result = await client.getPrompts("run-1");

      expect(mockInstance.get).toHaveBeenCalledWith("/redteam/sdk/runs/run-1/prompts");
      expect(result).toMatchObject({
        runId: "run-1",
        status: "running",
        prompts: [{ id: "p1", prompt: "attack", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
      });
    });
  });

  describe("submitTurn", () => {
    it("posts the turn body and returns {done, nextPrompt?, nextTurnIndex?}", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      mockInstance.post.mockResolvedValueOnce({
        data: { success: true, data: { done: false, nextPrompt: "turn 2", nextTurnIndex: 2 } },
      });
      const body = { promptId: "p1", sessionId: "s1", turnIndex: 1, promptText: "attack", output: "ok" };

      const result = await client.submitTurn("run-1", body);

      expect(mockInstance.post).toHaveBeenCalledWith("/redteam/sdk/runs/run-1/turns", body);
      expect(result).toEqual({ done: false, nextPrompt: "turn 2", nextTurnIndex: 2 });
    });

    it("surfaces an exact-duplicate-turn (409) submission as {done: true} instead of throwing", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      mockInstance.post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { success: false, error: { message: "already submitted" } } },
        message: "Request failed with status code 409",
      });
      const result = await client.submitTurn("run-1", {
        promptId: "p1",
        sessionId: "s1",
        turnIndex: 1,
        promptText: "attack",
        output: "ok",
      });
      expect(result).toEqual({ done: true });
    });
  });

  describe("_extractErrorMessage / typed error mapping via createRun", () => {
    const cases: Array<[number, any]> = [
      [400, RedTeamConfigError],
      [401, RedTeamAuthError],
      [403, RedTeamAuthError],
      [404, RedTeamConfigError],
      [409, RedTeamRunError],
      [422, RedTeamConfigError],
      [502, RedTeamGenerationError],
      [503, RedTeamGenerationTimeoutError],
    ];

    for (const [status, ErrorClass] of cases) {
      it(`maps HTTP ${status} to ${ErrorClass.name}`, async () => {
        const cfg = buildConfig("https://api.getnetra.ai");
        const client = new RedTeamHttpClient(cfg);
        // Persistent (not "Once") since 502/503 are retried by the client's
        // bounded-retry wrapper before finally throwing.
        mockInstance.post.mockRejectedValue({
          isAxiosError: true,
          response: { status, data: { success: false, error: { message: `error ${status}` } } },
          message: `Request failed with status code ${status}`,
        });
        await expect(client.createRun({ configId: "cfg-1" })).rejects.toBeInstanceOf(ErrorClass);
      });
    }

    it("uses the response envelope's error.message when present", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      mockInstance.post.mockRejectedValue({
        isAxiosError: true,
        response: { status: 404, data: { success: false, error: { message: "config not found" } } },
        message: "Request failed with status code 404",
      });
      await expect(client.createRun({ configId: "cfg-1" })).rejects.toThrow("config not found");
    });

    it("passes through a non-axios Error unchanged", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      const boom = new Error("boom");
      mockInstance.post.mockRejectedValue(boom);
      await expect(client.createRun({ configId: "cfg-1" })).rejects.toBe(boom);
    });

    it("retries a network error (no response) up to MAX_RETRIES before throwing", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      const networkError = { isAxiosError: true, message: "Network Error" };
      mockInstance.post.mockRejectedValue(networkError);
      await expect(client.createRun({ configId: "cfg-1" })).rejects.toBeInstanceOf(Error);
      // 1 initial attempt + 2 retries = 3 calls.
      expect(mockInstance.post).toHaveBeenCalledTimes(3);
    });

    it("does not retry a 400 (non-transient) error", async () => {
      const cfg = buildConfig("https://api.getnetra.ai");
      const client = new RedTeamHttpClient(cfg);
      mockInstance.post.mockRejectedValue({
        isAxiosError: true,
        response: { status: 400, data: { success: false, error: { message: "bad request" } } },
        message: "Request failed with status code 400",
      });
      await expect(client.createRun({ configId: "cfg-1" })).rejects.toBeInstanceOf(RedTeamConfigError);
      expect(mockInstance.post).toHaveBeenCalledTimes(1);
    });
  });

  it("getProgress returns the unwrapped envelope contents", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    const client = new RedTeamHttpClient(cfg);
    mockInstance.get.mockResolvedValueOnce({ data: { success: true, data: { completedSessions: 3 } } });
    const result = await client.getProgress("run-1");
    expect(result).toEqual({ completedSessions: 3 });
  });

  it("getResultsPage sends page/limit/evaluatorId query params with defaults", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    const client = new RedTeamHttpClient(cfg);
    mockInstance.get.mockResolvedValueOnce({
      data: { success: true, data: { data: [], page: 1, limit: 200, total: 0, hasNextPage: false } },
    });
    await client.getResultsPage("run-1");
    expect(mockInstance.get).toHaveBeenCalledWith("/redteam/sdk/runs/run-1/results", {
      params: { page: 1, limit: 200, evaluatorId: undefined },
    });
  });

  it("getRiskScore hits the config-scoped endpoint and returns the raw payload", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    const client = new RedTeamHttpClient(cfg);
    mockInstance.get.mockResolvedValueOnce({ data: { success: true, data: { latestSafetyScore: 77 } } });
    const result = await client.getRiskScore("cfg-1");
    expect(result).toEqual({ latestSafetyScore: 77 });
    expect(mockInstance.get).toHaveBeenCalledWith("/redteam/sdk/configs/cfg-1/risk-score");
  });

  it("cancel posts to the cancel endpoint and returns the unwrapped status", async () => {
    const cfg = buildConfig("https://api.getnetra.ai");
    const client = new RedTeamHttpClient(cfg);
    mockInstance.post.mockResolvedValueOnce({ data: { success: true, data: { status: "cancelled" } } });
    const result = await client.cancel("run-1");
    expect(result).toEqual({ status: "cancelled" });
    expect(mockInstance.post).toHaveBeenCalledWith("/redteam/sdk/runs/run-1/cancel");
  });

  it("throws RedTeamAuthError when the client was never initialized (no endpoint)", async () => {
    const cfg = new Config({});
    const client = new RedTeamHttpClient(cfg);
    expect(client.isInitialized()).toBe(false);
    await expect(client.createRun({ configId: "cfg-1" })).rejects.toBeInstanceOf(RedTeamAuthError);
  });
});
