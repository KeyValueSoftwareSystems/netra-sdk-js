/**
 * E2E: the local-agent callback contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRedteamBackend } from "./mock-backend";
import { newClient, resetRedteamEnv, FAST_POLL_ENV } from "./helpers";
import type { RedteamRunOptions } from "../../models";

describe("Callback contract", () => {
  let backend: MockRedteamBackend;

  beforeEach(async () => {
    backend = new MockRedteamBackend();
    await backend.start();
  });
  afterEach(async () => {
    await backend.stop();
    resetRedteamEnv();
  });

  function seedSingleTurnConfig(sessionsPerEvaluator = 1) {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator({ slug: "harmful-content" });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      sessionsPerEvaluator,
    });
    return { tenant, config };
  }

  it("handler is a plain arrow function (no class) — accepted, called successfully", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);
    let called = false;

    const result = await client.runRedteam({
      configId: config.id,
      handler: async (prompt, sessionId, turnIndex) => {
        called = true;
        expect(typeof prompt).toBe("string");
        expect(typeof sessionId).toBe("string");
        expect(typeof turnIndex).toBe("number");
        return "text";
      },
    });

    expect(called).toBe(true);
    expect(result!.success).toBe(true);
  });

  it("handler is not a function — rejected client-side before any network call", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const withObject = { configId: config.id, handler: {} } as unknown as RedteamRunOptions;
    expect(await client.runRedteam(withObject)).toBeNull();

    const withUndefined = { configId: config.id, handler: undefined } as unknown as RedteamRunOptions;
    expect(await client.runRedteam(withUndefined)).toBeNull();

    expect(backend.requestLog).toHaveLength(0);
  });

  it("handler returns a bare string — treated as the agent's message with no sessionId override", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => "my reply",
    });

    expect(result!.success).toBe(true);
    const submitCall = backend.requestLog.find((r) => r.path.includes("turns"));
    expect(submitCall!.body.output).toBe("my reply");
    expect(submitCall!.body.sessionId).toBeDefined(); // the session it was polled for, not an override
  });

  it("handler returns {message, sessionId} — overriding sessionId forwarded on turns", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => ({ message: "x", sessionId: "custom-session-override" }),
    });

    expect(result!.success).toBe(true);
    const submitCall = backend.requestLog.find((r) => r.path.includes("turns"));
    expect(submitCall!.body.output).toBe("x");
    expect(submitCall!.body.sessionId).toBe("custom-session-override");
  });

  it("handler returns an unsupported shape — treated as a handler error, submitted as {error}, run continues to finalize", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => 42 as unknown as string,
    });

    expect(result!.success).toBe(true); // run still finalizes
    const submitCall = backend.requestLog.find((r) => r.path.includes("turns"));
    expect(submitCall!.body.error).toBeDefined();
    expect(submitCall!.body.output).toBeUndefined();
    expect(result!.results[0].status).toBe("error");
  });

  it("handler throws synchronously or rejects — caught by SDK, submitted as {error}, run continues with partial results", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const result = await client.runRedteam({
      configId: config.id,
      handler: async () => {
        throw new Error("boom");
      },
    });

    expect(result!.success).toBe(true);
    const submitCall = backend.requestLog.find((r) => r.path.includes("turns"));
    expect(submitCall!.body.error).toContain("boom");
    expect(result!.results[0].status).toBe("error");
  });

  it("handler receives correct turnIndex sequence — single-turn (turnIndex===1)", async () => {
    const { tenant, config } = seedSingleTurnConfig();
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const seen: number[] = [];
    await client.runRedteam({
      configId: config.id,
      handler: async (_p, _s, turnIndex) => {
        seen.push(turnIndex);
        return "reply";
      },
    });

    expect(seen).toEqual([1]);
  });

  it("handler receives correct turnIndex sequence — multi-turn 1,2,3 in order for a given session", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const evaluator = backend.addEvaluator({ slug: "harmful-content" });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [evaluator.id],
      turnType: "multi",
      multiTurnCount: 3,
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const seen: number[] = [];
    await client.runRedteam({
      configId: config.id,
      handler: async (_p, _s, turnIndex) => {
        seen.push(turnIndex);
        return "reply";
      },
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it("handler receives correct turnIndex sequence — iterative jailbreak, increasing up to the cap or an early stop", async () => {
    const tenant = backend.addTenant();
    const agent = backend.addAgent({ projectId: tenant.projectId });
    const jailbreakEvaluator = backend.addEvaluator({ slug: "jailbreak-eval", isJailbreak: true });
    const config = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [jailbreakEvaluator.id],
    });
    const client = newClient(backend, tenant.apiKey, FAST_POLL_ENV);

    const seen: number[] = [];
    const result = await client.runRedteam({
      configId: config.id,
      handler: async (_p, _s, turnIndex) => {
        seen.push(turnIndex);
        return "reply";
      },
    });

    expect(result!.success).toBe(true);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual(seen.map((_v, i) => i + 1)); // strictly increasing from 1

    // Early-stop path: the mock's early-stop sentinel makes the run finish
    // before the iteration cap.
    const seenEarly: number[] = [];
    const config2 = backend.addConfig({
      projectId: tenant.projectId,
      orgId: tenant.orgId,
      agentId: agent.id,
      evaluatorIds: [jailbreakEvaluator.id],
    });
    const result2 = await client.runRedteam({
      configId: config2.id,
      handler: async (_p, _s, turnIndex) => {
        seenEarly.push(turnIndex);
        return turnIndex === 2 ? "STOP_EARLY now" : "reply";
      },
    });
    expect(result2!.success).toBe(true);
    expect(seenEarly).toEqual([1, 2]);
    expect(seenEarly.length).toBeLessThan(seen.length);
  });
});
