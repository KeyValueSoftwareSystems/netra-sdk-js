import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockClient = {
  isInitialized: vi.fn(() => true),
  createRun: vi.fn(),
  getPrompts: vi.fn(),
  submitTurn: vi.fn(),
  getProgress: vi.fn(),
  getResultsPage: vi.fn(),
  getRiskScore: vi.fn(),
  cancel: vi.fn(),
};

vi.mock("../client", () => {
  return {
    RedteamHttpClient: vi.fn().mockImplementation(function RedteamHttpClient() {
      return mockClient;
    }),
  };
});

import { Redteam } from "../api";
import { RedteamRunOptions } from "../models";

const fakeConfig = {} as any;

function resetMocks() {
  for (const fn of Object.values(mockClient)) {
    (fn as any).mockReset();
  }
  mockClient.isInitialized.mockReturnValue(true);
  mockClient.cancel.mockResolvedValue({ status: "cancelled" });
  mockClient.getProgress.mockResolvedValue({ completedSessions: 1 });
  mockClient.getRiskScore.mockResolvedValue({ latestSafetyScore: 95 });
}

describe("Redteam", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetMocks();
    process.env.NETRA_REDTEAM_GENERATION_POLL_INTERVAL = "0";
    process.env.NETRA_REDTEAM_GENERATION_TIMEOUT = "5";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("happy path single-turn: create(running) -> fetch prompts once -> drive to done -> results + progress + risk score", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-1", configId: "cfg-1", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({
        runId: "run-1",
        status: "running",
        turnType: "single",
        multiTurnCount: 5,
        prompts: [{ id: "p1", prompt: "attack", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
      })
      // Re-read at the end to determine final status.
      .mockResolvedValueOnce({ runId: "run-1", status: "completed", turnType: "single", multiTurnCount: 5, prompts: [] });
    mockClient.submitTurn.mockResolvedValueOnce({ done: true });
    mockClient.getResultsPage.mockResolvedValueOnce({
      items: [{ evaluatorId: "ev-1", status: "pass", score: 1 }],
      page: 1,
      limit: 200,
      total: 1,
    });

    const handler = vi.fn(async (prompt: string, _sessionId: string, _turnIndex: number) => `reply:${prompt}`);
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-1", handler, maxConcurrency: 1 };

    const result = await redteam.runRedteam(options);

    expect(handler).toHaveBeenCalledWith("attack", "p1", 1);
    expect(mockClient.submitTurn).toHaveBeenCalledWith("run-1", {
      promptId: "p1",
      sessionId: "p1",
      turnIndex: 1,
      promptText: "attack",
      output: "reply:attack",
    });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.status).toBe("completed");
    expect(result!.results).toHaveLength(1);
    expect(result!.progress).toEqual({ completedSessions: 1 });
    expect(result!.riskScore).toEqual({ latestSafetyScore: 95 });
    expect(mockClient.getPrompts).toHaveBeenCalledTimes(2);
  });

  it("still generating after create: retries createRun with {configId} on an interval until running", async () => {
    mockClient.createRun
      .mockResolvedValueOnce({ configId: "cfg-2", status: "generating" })
      .mockResolvedValueOnce({ configId: "cfg-2", status: "generating" })
      .mockResolvedValueOnce({ configId: "cfg-2", status: "generating" })
      .mockResolvedValueOnce({ runId: "run-2", configId: "cfg-2", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({ runId: "run-2", status: "running", turnType: "multi", multiTurnCount: 5, prompts: [] })
      .mockResolvedValueOnce({ runId: "run-2", status: "completed", turnType: "multi", multiTurnCount: 5, prompts: [] });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const handler = vi.fn(async () => "unused");
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-2", handler, maxConcurrency: 1 };

    const result = await redteam.runRedteam(options);

    expect(mockClient.createRun).toHaveBeenNthCalledWith(1, { configId: "cfg-2" });
    expect(mockClient.createRun).toHaveBeenNthCalledWith(2, { configId: "cfg-2" });
    expect(mockClient.createRun).toHaveBeenNthCalledWith(3, { configId: "cfg-2" });
    expect(mockClient.createRun).toHaveBeenNthCalledWith(4, { configId: "cfg-2" });
    expect(mockClient.createRun).toHaveBeenCalledTimes(4);
    expect(result).not.toBeNull();
    expect(result!.runId).toBe("run-2");
    expect(result!.configId).toBe("cfg-2");
  });

  it("multi-turn: incrementing turnIndex across turns via nextPrompt/nextTurnIndex, done:false until the last submit", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-3", configId: "cfg-3", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({
        runId: "run-3",
        status: "running",
        turnType: "multi",
        multiTurnCount: 3,
        prompts: [{ id: "p1", prompt: "p0", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
      })
      .mockResolvedValueOnce({ runId: "run-3", status: "completed", turnType: "multi", multiTurnCount: 3, prompts: [] });
    mockClient.submitTurn
      .mockResolvedValueOnce({ done: false, nextPrompt: "p1", nextTurnIndex: 2 })
      .mockResolvedValueOnce({ done: false, nextPrompt: "p2", nextTurnIndex: 3 })
      .mockResolvedValueOnce({ done: true });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const handler = vi.fn(async (prompt: string, _sessionId: string, turnIndex: number) => `r${turnIndex}:${prompt}`);
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-3", handler, maxConcurrency: 1 };

    const result = await redteam.runRedteam(options);

    expect(handler).toHaveBeenNthCalledWith(1, "p0", "p1", 1);
    expect(handler).toHaveBeenNthCalledWith(2, "p1", "p1", 2);
    expect(handler).toHaveBeenNthCalledWith(3, "p2", "p1", 3);
    expect(mockClient.submitTurn).toHaveBeenNthCalledWith(1, "run-3", {
      promptId: "p1",
      sessionId: "p1",
      turnIndex: 1,
      promptText: "p0",
      output: "r1:p0",
    });
    expect(mockClient.submitTurn).toHaveBeenNthCalledWith(2, "run-3", {
      promptId: "p1",
      sessionId: "p1",
      turnIndex: 2,
      promptText: "p1",
      output: "r2:p1",
    });
    expect(mockClient.submitTurn).toHaveBeenNthCalledWith(3, "run-3", {
      promptId: "p1",
      sessionId: "p1",
      turnIndex: 3,
      promptText: "p2",
      output: "r3:p2",
    });
    expect(result!.success).toBe(true);
  });

  it("backend-reported run failure surfaces as success:false/status:\"failed\", not hard-coded completed", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-10", configId: "cfg-10", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({ runId: "run-10", status: "running", turnType: "single", multiTurnCount: 5, prompts: [] })
      .mockResolvedValueOnce({ runId: "run-10", status: "failed", turnType: "single", multiTurnCount: 5, prompts: [] });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const handler = vi.fn(async () => "unused");
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-10", handler, maxConcurrency: 1 };

    const result = await redteam.runRedteam(options);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.success).toBe(false);
  });

  it("zero generated prompts: warns, still completes with empty results", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-11", configId: "cfg-11", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({ runId: "run-11", status: "running", turnType: "single", multiTurnCount: 5, prompts: [] })
      .mockResolvedValueOnce({ runId: "run-11", status: "completed", turnType: "single", multiTurnCount: 5, prompts: [] });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const handler = vi.fn(async () => "unused");
    const redteam = new Redteam(fakeConfig);
    const result = await redteam.runRedteam({ configId: "cfg-11", handler, maxConcurrency: 1 });

    expect(handler).not.toHaveBeenCalled();
    expect(mockClient.submitTurn).not.toHaveBeenCalled();
    expect(result!.results).toHaveLength(0);
  });

  it("fatal submitTurn error trips the shared stop signal (sibling stops instead of continuing) and propagates to the caller", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-13", configId: "cfg-13", status: "running" });
    mockClient.getPrompts.mockResolvedValueOnce({
      runId: "run-13",
      status: "running",
      turnType: "single",
      multiTurnCount: 5,
      prompts: [
        { id: "pA", prompt: "attack A", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" },
        { id: "pB", prompt: "attack B", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" },
      ],
    });
    const fatal = new Error("503 exhausted");
    let submitCallsForB = 0;
    mockClient.submitTurn.mockImplementation(async (_runId: string, body: any) => {
      if (body.promptId === "pA") {
        throw fatal;
      }
      // Poller B: would otherwise keep going turn after turn forever. A tiny
      // real delay (unlike an instantly-resolved mock) lets the event loop
      // actually yield between iterations, so the stop-signal check has a
      // chance to interleave instead of the loop spinning unboundedly fast.
      await new Promise((resolve) => setTimeout(resolve, 1));
      submitCallsForB++;
      return { done: false, nextPrompt: "next", nextTurnIndex: body.turnIndex + 1 };
    });

    const handler = vi.fn(async () => "unused");
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-13", handler, maxConcurrency: 2 };

    await expect(redteam.runRedteam(options)).rejects.toThrow("503 exhausted");

    const callsAtRejection = submitCallsForB;
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Session B must notice the tripped stop signal on its next loop check
    // rather than continuing to submit turns indefinitely.
    expect(submitCallsForB).toBeLessThanOrEqual(callsAtRejection + 1);
  });

  it("handler throws -> submits {error}, turn recorded error, run still finalizes", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-6", configId: "cfg-6", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({
        runId: "run-6",
        status: "running",
        turnType: "single",
        multiTurnCount: 5,
        prompts: [{ id: "p1", prompt: "p0", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
      })
      .mockResolvedValueOnce({ runId: "run-6", status: "completed", turnType: "single", multiTurnCount: 5, prompts: [] });
    mockClient.submitTurn.mockResolvedValueOnce({ done: true });
    mockClient.getResultsPage.mockResolvedValueOnce({
      items: [{ evaluatorId: "ev-1", status: "error" }],
      page: 1,
      limit: 200,
      total: 1,
    });

    const handler = vi.fn(async () => {
      throw new Error("agent blew up");
    });
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-6", handler, maxConcurrency: 1 };

    const result = await redteam.runRedteam(options);

    expect(mockClient.submitTurn).toHaveBeenCalledWith("run-6", {
      promptId: "p1",
      sessionId: "p1",
      turnIndex: 1,
      promptText: "p0",
      error: "agent blew up",
    });
    expect(result!.success).toBe(true);
    expect(result!.results[0]).toMatchObject({ status: "error" });
  });

  it("drives multiple sessions concurrently (bounded by maxConcurrency), each independently to done", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-7", configId: "cfg-7", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({
        runId: "run-7",
        status: "running",
        turnType: "single",
        multiTurnCount: 5,
        prompts: [
          { id: "pA", prompt: "attack A", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" },
          { id: "pB", prompt: "attack B", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" },
        ],
      })
      .mockResolvedValueOnce({ runId: "run-7", status: "completed", turnType: "single", multiTurnCount: 5, prompts: [] });
    mockClient.submitTurn.mockResolvedValue({ done: true });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const seenSessions: string[] = [];
    const handler = vi.fn(async (_prompt: string, sessionId: string) => {
      seenSessions.push(sessionId);
      return "ok";
    });
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-7", handler, maxConcurrency: 2 };

    await redteam.runRedteam(options);

    expect(seenSessions.sort()).toEqual(["pA", "pB"]);
    const submittedSessions = mockClient.submitTurn.mock.calls.map((call: any[]) => call[1].sessionId);
    expect(submittedSessions.sort()).toEqual(["pA", "pB"]);
  });

  it("interrupt (SIGINT) -> single-fire cancel call, re-raises the signal so the process still terminates, run resolves as cancelled", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-8", configId: "cfg-8", status: "running" });
    // A session that never finishes on its own — the interrupt must cut it short.
    mockClient.getPrompts.mockResolvedValueOnce({
      runId: "run-8",
      status: "running",
      turnType: "multi",
      multiTurnCount: 1000,
      prompts: [{ id: "p1", prompt: "attack", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
    });
    mockClient.submitTurn.mockImplementation(async (_runId: string, body: any) => {
      // A tiny real delay lets the interrupt actually interleave instead of
      // the loop spinning unboundedly fast against an instantly-resolved mock.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { done: false, nextPrompt: "next", nextTurnIndex: body.turnIndex + 1 };
    });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    // Prevent the re-raised SIGINT from actually terminating the test
    // process while still letting us assert it fired (LLD §11).
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);

    const handler = vi.fn(async () => "ok");
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-8", handler, maxConcurrency: 1 };

    const runPromise = redteam.runRedteam(options);

    // Let a couple of turns happen, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGINT" as any);
    process.emit("SIGINT" as any); // second emission must NOT trigger a second cancel call

    const result = await runPromise;

    expect(mockClient.cancel).toHaveBeenCalledTimes(1);
    expect(mockClient.cancel).toHaveBeenCalledWith("run-8");
    expect(result!.status).toBe("cancelled");
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");

    killSpy.mockRestore();
  });

  it("does NOT install uncaughtException/unhandledRejection listeners, and an unrelated error never cancels the run", async () => {
    mockClient.createRun.mockResolvedValueOnce({ runId: "run-9", configId: "cfg-9", status: "running" });
    mockClient.getPrompts
      .mockResolvedValueOnce({
        runId: "run-9",
        status: "running",
        turnType: "multi",
        multiTurnCount: 1000,
        prompts: [{ id: "p1", prompt: "attack", evaluatorId: "ev-1", evaluatorSlug: "harmful-hate" }],
      })
      .mockResolvedValueOnce({ runId: "run-9", status: "completed", turnType: "multi", multiTurnCount: 1000, prompts: [] });
    mockClient.submitTurn.mockImplementation(async (_runId: string, body: any) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { done: false, nextPrompt: "next", nextTurnIndex: body.turnIndex + 1 };
    });
    mockClient.getResultsPage.mockResolvedValueOnce({ items: [], page: 1, limit: 200, total: 0 });

    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const exceptionBefore = process.listenerCount("uncaughtException");
    const rejectionBefore = process.listenerCount("unhandledRejection");

    const handler = vi.fn(async () => "ok");
    const redteam = new Redteam(fakeConfig);
    const options: RedteamRunOptions = { configId: "cfg-9", handler, maxConcurrency: 1 };

    const runPromise = redteam.runRedteam(options);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // runRedteam must never add its own uncaughtException/unhandledRejection listeners — an
    // unrelated error elsewhere in the host process must not be able to cancel this run.
    expect(process.listenerCount("uncaughtException")).toBe(exceptionBefore);
    expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
    // SIGINT/SIGTERM listeners ARE expected while the run is in flight.
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);

    mockClient.submitTurn.mockResolvedValue({ done: true });
    const result = await runPromise;

    expect(mockClient.cancel).not.toHaveBeenCalled();
    expect(result!.status).toBe("completed");
    // Listeners must be removed once the run settles normally (no leak).
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("getResults pages until a short page, concatenating all items", async () => {
    mockClient.getResultsPage
      .mockResolvedValueOnce({
        items: Array.from({ length: 200 }, (_, i) => ({ evaluatorId: `ev-${i}`, status: "pass" })),
        page: 1,
        limit: 200,
        total: 401,
      })
      .mockResolvedValueOnce({
        items: Array.from({ length: 200 }, (_, i) => ({ evaluatorId: `ev-${200 + i}`, status: "pass" })),
        page: 2,
        limit: 200,
        total: 401,
      })
      .mockResolvedValueOnce({
        items: [{ evaluatorId: "ev-400", status: "pass" }],
        page: 3,
        limit: 200,
        total: 401,
      });

    const redteam = new Redteam(fakeConfig);
    const results = await redteam.getResults("run-9");

    expect(results).toHaveLength(401);
    expect(mockClient.getResultsPage).toHaveBeenCalledTimes(3);
    expect(mockClient.getResultsPage).toHaveBeenNthCalledWith(1, "run-9", { page: 1, limit: 200 });
    expect(mockClient.getResultsPage).toHaveBeenNthCalledWith(2, "run-9", { page: 2, limit: 200 });
    expect(mockClient.getResultsPage).toHaveBeenNthCalledWith(3, "run-9", { page: 3, limit: 200 });
  });

  it("returns null for invalid input without any network call", async () => {
    const redteam = new Redteam(fakeConfig);
    const result = await redteam.runRedteam({ handler: "not-a-fn" } as any);
    expect(result).toBeNull();
    expect(mockClient.createRun).not.toHaveBeenCalled();
  });
});
