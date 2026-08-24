/**
 * E2E: cancellation and interruption.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import { Config } from "../../../../config";
import { RedteamHttpClient } from "../../client";

describe("Cancellation and interruption", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  function seed() {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator();
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      turnType: "multi",
      multiTurnCount: 5,
    });
    return { tenant, config };
  }

  it("explicit cancel mid-run — run transitions to cancelled, pollers stop, result reflects status:cancelled", async () => {
    const { tenant, config } = seed();
    process.env.NETRA_OTLP_ENDPOINT = backend.url;
    process.env.NETRA_API_KEY = tenant.apiKey;
    const raw = new RedteamHttpClient(new Config({}));
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    // Simulate "turns in progress": fetch the prompt list, submit one turn (not final, multiTurnCount=5).
    const promptsResp = await raw.getPrompts(created.runId);
    const [prompt] = promptsResp.prompts;
    await raw.submitTurn(created.runId, {
      promptId: prompt.id,
      sessionId: prompt.id,
      turnIndex: 1,
      promptText: prompt.prompt,
      output: "reply",
    });

    const cancelResult = await raw.cancel(created.runId);
    expect(cancelResult.status).toBe("cancelled");

    const afterCancel = await raw.getPrompts(created.runId);
    expect(afterCancel.status).toBe("cancelled"); // no more turns will be accepted
    expect(backend.getRun(created.runId)!.status).toBe("cancelled");
  });

  it("Netra.redteam.cancel(runId) reaches the real backend and marks the run cancelled", async () => {
    const { tenant, config } = seed();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    process.env.NETRA_OTLP_ENDPOINT = backend.url;
    process.env.NETRA_API_KEY = tenant.apiKey;
    const raw = new RedteamHttpClient(new Config({}));
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    const cancelResult = await client.cancel(created.runId);
    expect(cancelResult.status).toBe("cancelled");
    expect(backend.getRun(created.runId)!.status).toBe("cancelled");
  });

  it("process interrupt (SIGINT) mid-run — SDK issues a single cancel call before exiting; no orphaned RUNNING run", async () => {
    // The real SDK's interrupt handler re-delivers the signal via
    // `process.kill(process.pid, signal)` once it's done cancelling, so that
    // Ctrl-C still terminates the developer's process normally. Sending a
    // REAL SIGINT to the process running this test suite
    // would kill the test runner, so `process.kill` is stubbed for the
    // duration of this test to observe that re-delivery attempt safely,
    // without ever executing it. This stubs only a Node global for isolation
    // — it does not touch, weaken, or mock any product code path.
    const originalKill = process.kill.bind(process);
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      const { tenant, config } = seed();
      const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

      const runPromise = client.runRedteam({
        configId: config.id,
        maxConcurrency: 1,
        // A tiny per-turn delay keeps the (multiTurnCount=5) session from
        // completing naturally before the interrupt has a chance to land.
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "reply";
        },
      });

      // Wait until the SDK has genuinely started driving the session (proves
      // its SIGINT listener — registered right after create-run resolves, and
      // before the prompt-list fetch — is already attached) before firing the
      // interrupt, so it isn't lost to a race.
      const deadline = Date.now() + 3000;
      while (backend.requestLog.filter((r) => r.path.includes("/prompts")).length === 0) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the session drive to start");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      process.emit("SIGINT" as any);

      const result = await runPromise;
      expect(result).not.toBeNull();
      expect(result!.status).toBe("cancelled");

      // The interrupt handler's own cancel() call is fire-and-forget from
      // runRedteam's perspective — poll briefly for it to actually land.
      const cancelDeadline = Date.now() + 2000;
      while (backend.requestLog.filter((r) => r.path.includes("/cancel")).length === 0) {
        if (Date.now() > cancelDeadline) throw new Error("timed out waiting for the interrupt's cancel() call");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const cancelCalls = backend.requestLog.filter((r) => r.path.includes("/cancel"));
      expect(cancelCalls.length).toBe(1); // exactly one cancel call, not zero, not duplicated

      const run = [...backend.runs.values()].find((r) => r.configId === config.id);
      expect(run!.status).not.toBe("running"); // no orphaned RUNNING run left behind

      expect(killCalls.length).toBe(1); // signal re-delivery was attempted exactly once
      expect(killCalls[0].signal).toBe("SIGINT");
    } finally {
      process.kill = originalKill;
    }
  });

  it("cancel an already-finished run — 409, no state corruption", async () => {
    const { tenant, config } = seed();
    config.turnType = "single";
    process.env.NETRA_OTLP_ENDPOINT = backend.url;
    process.env.NETRA_API_KEY = tenant.apiKey;
    const raw = new RedteamHttpClient(new Config({}));
    const created = await raw.createRun({ configId: config.id });
    if (created.status !== "running") throw new Error("expected running");

    const promptsResp = await raw.getPrompts(created.runId);
    const [prompt] = promptsResp.prompts;
    const submit = await raw.submitTurn(created.runId, {
      promptId: prompt.id,
      sessionId: prompt.id,
      turnIndex: 1,
      promptText: prompt.prompt,
      output: "reply",
    });
    expect(submit.done).toBe(true); // run already completed (single-turn)

    await expect(raw.cancel(created.runId)).rejects.toThrow();
    // State unchanged by the failed cancel attempt.
    expect(backend.getRun(created.runId)!.status).toBe("completed");
  });
});
